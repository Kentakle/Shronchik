namespace Shronchik.Server.Storage;

/// <summary>Stops new API work and drains existing streams before changing library paths.</summary>
public sealed class StorageRequestGate
{
    private readonly object sync = new();
    private CancellationTokenSource cancellation = new();
    private int requests;
    private bool changing;
    private TaskCompletionSource? drained;

    public RequestLease Enter()
    {
        lock (sync)
        {
            if (changing) throw new StorageException(503, "storage_busy");
            requests++;
            return new(this, cancellation.Token);
        }
    }

    public async Task<IDisposable> BeginTransitionAsync(RequestLease current, CancellationToken ct)
    {
        Task pending;
        CancellationTokenSource previous;
        lock (sync)
        {
            if (changing || current.Released) throw new StorageException(503, "storage_busy");
            changing = true;
            current.ReleaseCore();
            previous = cancellation;
            pending = requests == 0 ? Task.CompletedTask
                : (drained ??= new(TaskCreationOptions.RunContinuationsAsynchronously)).Task;
        }
        try
        {
            // Cancellation runs callbacks outside the gate lock; callbacks can finish requests.
            previous.Cancel();
            await pending.WaitAsync(ct);
            return new TransitionLease(this);
        }
        catch
        {
            EndTransition();
            throw;
        }
    }

    private void EndTransition()
    {
        lock (sync)
        {
            cancellation = new();
            drained = null;
            changing = false;
        }
    }

    public sealed class RequestLease : IDisposable
    {
        private readonly StorageRequestGate owner;
        internal bool Released { get; private set; }
        public CancellationToken Token { get; }
        internal RequestLease(StorageRequestGate owner, CancellationToken token) { this.owner = owner; Token = token; }
        internal void ReleaseCore()
        {
            if (Released) return;
            Released = true;
            if (--owner.requests == 0) owner.drained?.TrySetResult();
        }
        public void Dispose() { lock (owner.sync) ReleaseCore(); }
    }

    private sealed class TransitionLease(StorageRequestGate owner) : IDisposable
    {
        private int disposed;
        public void Dispose() { if (Interlocked.Exchange(ref disposed, 1) == 0) owner.EndTransition(); }
    }
}
