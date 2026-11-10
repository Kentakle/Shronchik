# Windows closes the job handle even when this console is closed or PowerShell is
# terminated. Children are attached before their first instruction can execute.
if (-not ('Shronchik.Hosting.ProcessScope' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace Shronchik.Hosting
{
    public sealed class ProcessScope : IDisposable
    {
        private IntPtr job;

        public ProcessScope()
        {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception();
            var limits = new JobLimits();
            limits.BasicLimitInformation.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits)))
            {
                int error = Marshal.GetLastWin32Error();
                Dispose();
                throw new Win32Exception(error);
            }
        }

        public Process Start(string executable, string arguments, string directory,
            string outputPath, string errorPath)
        {
            if (job == IntPtr.Zero) throw new ObjectDisposedException("ProcessScope");
            var startup = new StartupInfo();
            startup.cb = Marshal.SizeOf(startup);
            var info = new ProcessInformation();
            IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
            Process process = null;
            try
            {
                if (!String.IsNullOrEmpty(outputPath))
                {
                    input = OpenFile("NUL", 0x80000000, 3);
                    output = OpenFile(outputPath, 0x40000000, 2);
                    error = OpenFile(errorPath, 0x40000000, 2);
                    startup.dwFlags = 0x100; // STARTF_USESTDHANDLES
                    startup.hStdInput = input;
                    startup.hStdOutput = output;
                    startup.hStdError = error;
                }
                var command = new StringBuilder("\"" + executable + "\" " + arguments);
                if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true,
                    4, IntPtr.Zero, directory, ref startup, out info)) // CREATE_SUSPENDED
                    throw new Win32Exception();
                if (!AssignProcessToJobObject(job, info.hProcess)) throw new Win32Exception();
                process = Process.GetProcessById((int)info.dwProcessId);
                // Open an independent handle while the process is still suspended.
                IntPtr processHandle = process.Handle;
                if (ResumeThread(info.hThread) == UInt32.MaxValue) throw new Win32Exception();
                return process;
            }
            catch
            {
                if (info.hProcess != IntPtr.Zero) TerminateProcess(info.hProcess, 1);
                if (process != null) process.Dispose();
                throw;
            }
            finally
            {
                Close(input); Close(output); Close(error);
                Close(info.hThread); Close(info.hProcess);
            }
        }

        private static IntPtr OpenFile(string path, uint access, uint creation)
        {
            var security = new SecurityAttributes();
            security.nLength = Marshal.SizeOf(security);
            security.bInheritHandle = true;
            IntPtr handle = CreateFile(path, access, 3, ref security, creation, 0x80, IntPtr.Zero);
            if (handle == new IntPtr(-1)) throw new Win32Exception();
            return handle;
        }

        private static void Close(IntPtr handle)
        {
            if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
        }

        public void Dispose()
        {
            if (job != IntPtr.Zero)
            {
                CloseHandle(job);
                job = IntPtr.Zero;
            }
            GC.SuppressFinalize(this);
        }

        ~ProcessScope() { Dispose(); }

        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimits
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct JobLimits
        {
            public BasicLimits BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct SecurityAttributes
        {
            public int nLength;
            public IntPtr lpSecurityDescriptor;
            [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct StartupInfo
        {
            public int cb;
            public string lpReserved, lpDesktop, lpTitle;
            public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public ushort wShowWindow, cbReserved2;
            public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInformation
        {
            public IntPtr hProcess, hThread;
            public uint dwProcessId, dwThreadId;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JobLimits info, int length);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateProcess(string application, StringBuilder command,
            IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags,
            IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation process);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFile(string path, uint access, uint share,
            ref SecurityAttributes security, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);
    }
}
'@
}
