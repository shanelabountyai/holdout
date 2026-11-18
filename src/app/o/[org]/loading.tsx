// Shown while an org page loads (a readout is computed from stored events on every view).
export default function Loading() {
  return (
    <main className="ho-main">
      <p role="status" className="ho-small">Loading…</p>
    </main>
  );
}
