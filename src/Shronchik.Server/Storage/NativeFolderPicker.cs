using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;

namespace Shronchik.Server.Storage;

/// <summary>A local Windows folder dialog without a Windows Desktop runtime dependency.</summary>
internal static class NativeFolderPicker
{
    private const int Cancelled = unchecked((int)0x800704c7);
    private static int open;

    public static Task<string?> PickAsync(string? initialPath, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        if (!OperatingSystem.IsWindows() || !Environment.UserInteractive)
            throw new StorageException(501, "folder_picker_unavailable");
        if (Interlocked.CompareExchange(ref open, 1, 0) != 0)
            throw new StorageException(409, "folder_picker_busy");

        var completion = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var owner = GetForegroundWindow();
        try
        {
            var thread = new Thread(() =>
            {
                if (OperatingSystem.IsWindows()) Run(initialPath, owner, ct, completion);
            })
            {
                IsBackground = true,
                Name = "Shronchik folder picker"
            };
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
        }
        catch
        {
            Interlocked.Exchange(ref open, 0);
            throw;
        }
        return completion.Task;
    }

    [SupportedOSPlatform("windows")]
    private static void Run(string? initialPath, nint owner, CancellationToken ct, TaskCompletionSource<string?> completion)
    {
        IFileDialog? dialog = null;
        IShellItem? initialFolder = null;
        IShellItem? selectedFolder = null;
        string? selectedPath = null;
        Exception? failure = null;
        var threadId = GetCurrentThreadId();
        var windowSync = new object();
        var active = true;
        var activated = false;
        // Show pumps its own STA messages. Closing only this dedicated thread's
        // common dialog also handles cancellation just before its HWND exists.
        using var monitor = new Timer(_ =>
        {
            lock (windowSync)
            {
                if (!active) return;
                EnumThreadWindows(threadId, (window, _) =>
                {
                    var className = new StringBuilder(64);
                    GetClassName(window, className, className.Capacity);
                    if (className.ToString() != "#32770") return true;
                    if (ct.IsCancellationRequested)
                    {
                        PostMessage(window, 0x0010, 0, 0); // WM_CLOSE
                    }
                    else if (!activated)
                    {
                        // The server can inherit STARTUPINFO SW_HIDE from its
                        // console launcher. Explicitly show the user-requested
                        // dialog; the server and console remain hidden.
                        ShowWindowAsync(window, 1); // SW_SHOWNORMAL
                        if (IsWindowVisible(window))
                        {
                            SetForegroundWindow(window);
                            activated = true;
                        }
                    }
                    return true;
                }, 0);
            }
        }, null, 0, 100);
        try
        {
            ct.ThrowIfCancellationRequested();
            var type = Type.GetTypeFromCLSID(new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7"), throwOnError: true)!;
            dialog = (IFileDialog)Activator.CreateInstance(type)!;
            Marshal.ThrowExceptionForHR(dialog.GetOptions(out var options));
            // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_DONTADDTORECENT.
            Marshal.ThrowExceptionForHR(dialog.SetOptions(options | 0x20 | 0x40 | 0x800 | 0x02000000));
            Marshal.ThrowExceptionForHR(dialog.SetTitle("Выберите папку библиотеки"));
            Marshal.ThrowExceptionForHR(dialog.SetOkButtonLabel("Выбрать папку"));

            var startingPath = ExistingFolder(initialPath);
            if (startingPath is not null)
            {
                var itemId = typeof(IShellItem).GUID;
                if (SHCreateItemFromParsingName(startingPath, 0, ref itemId, out initialFolder) >= 0)
                    Marshal.ThrowExceptionForHR(dialog.SetFolder(initialFolder));
            }
            ct.ThrowIfCancellationRequested();
            var result = dialog.Show(owner);
            ct.ThrowIfCancellationRequested();
            if (result != Cancelled)
            {
                Marshal.ThrowExceptionForHR(result);
                Marshal.ThrowExceptionForHR(dialog.GetResult(out selectedFolder));
                Marshal.ThrowExceptionForHR(selectedFolder.GetDisplayName(0x80058000, out var name)); // SIGDN_FILESYSPATH
                try { selectedPath = Marshal.PtrToStringUni(name); }
                finally { Marshal.FreeCoTaskMem(name); }
                if (string.IsNullOrWhiteSpace(selectedPath) || !Directory.Exists(selectedPath))
                    throw new StorageException(400, "invalid_storage_path");
            }
        }
        catch (OperationCanceledException ex) { failure = ex; }
        catch (StorageException ex) { failure = ex; }
        catch (Exception ex) when (ex is COMException or InvalidCastException or TypeLoadException)
        { failure = new StorageException(501, "folder_picker_unavailable"); }
        catch (Exception ex) { failure = ex; }
        finally
        {
            lock (windowSync) active = false;
            Release(selectedFolder);
            Release(initialFolder);
            Release(dialog);
            Interlocked.Exchange(ref open, 0);
        }

        if (failure is OperationCanceledException) completion.TrySetCanceled(ct);
        else if (failure is not null) completion.TrySetException(failure);
        else completion.TrySetResult(selectedPath);
    }

    private static string? ExistingFolder(string? path)
    {
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path)) return null;
        try
        {
            var folder = Path.GetFullPath(path);
            while (!Directory.Exists(folder))
            {
                var parent = Path.GetDirectoryName(folder);
                if (parent is null || parent == folder) return null;
                folder = parent;
            }
            return folder;
        }
        catch (ArgumentException) { return null; }
        catch (NotSupportedException) { return null; }
    }

    [SupportedOSPlatform("windows")]
    private static void Release(object? value)
    {
        // Distinct out parameters can share an RCW when the initial folder is selected.
        if (value is null || !Marshal.IsComObject(value)) return;
        try { Marshal.ReleaseComObject(value); }
        catch (InvalidComObjectException) { }
    }

    [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog
    {
        [PreserveSig] int Show(nint owner);
        [PreserveSig] int SetFileTypes(uint count, nint filters);
        [PreserveSig] int SetFileTypeIndex(uint index);
        [PreserveSig] int GetFileTypeIndex(out uint index);
        [PreserveSig] int Advise(nint events, out uint cookie);
        [PreserveSig] int Unadvise(uint cookie);
        [PreserveSig] int SetOptions(uint options);
        [PreserveSig] int GetOptions(out uint options);
        [PreserveSig] int SetDefaultFolder(IShellItem folder);
        [PreserveSig] int SetFolder(IShellItem folder);
        [PreserveSig] int GetFolder(out IShellItem folder);
        [PreserveSig] int GetCurrentSelection(out IShellItem item);
        [PreserveSig] int SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int GetFileName(out nint name);
        [PreserveSig] int SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        [PreserveSig] int SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        [PreserveSig] int SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        [PreserveSig] int GetResult(out IShellItem item);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        [PreserveSig] int BindToHandler(nint bindContext, ref Guid handler, ref Guid item, out nint result);
        [PreserveSig] int GetParent(out IShellItem parent);
        [PreserveSig] int GetDisplayName(uint type, out nint name);
        [PreserveSig] int GetAttributes(uint mask, out uint attributes);
        [PreserveSig] int Compare(IShellItem item, uint hint, out int order);
    }

    private delegate bool EnumWindowsCallback(nint window, nint state);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumThreadWindows(uint threadId, EnumWindowsCallback callback, nint state);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(nint window, StringBuilder name, int length);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsWindowVisible(nint window);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool ShowWindowAsync(nint window, int command);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetForegroundWindow(nint window);
    [DllImport("user32.dll", EntryPoint = "PostMessageW")] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PostMessage(nint window, uint message, nint wParam, nint lParam);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SHCreateItemFromParsingName([MarshalAs(UnmanagedType.LPWStr)] string path, nint context, ref Guid id,
        [MarshalAs(UnmanagedType.Interface)] out IShellItem item);
}
