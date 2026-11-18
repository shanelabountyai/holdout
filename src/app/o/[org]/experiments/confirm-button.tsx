'use client';

// A submit button that asks first, for the actions that cannot be undone (start freezes the design, stop ends the
// experiment, delete removes the draft). Cancelling keeps the form unsent.
export function ConfirmButton({ question, className, children }: { question: string; className: string; children: React.ReactNode }) {
  return (
    <button type="submit" className={className} onClick={(e) => { if (!window.confirm(question)) e.preventDefault(); }}>
      {children}
    </button>
  );
}
