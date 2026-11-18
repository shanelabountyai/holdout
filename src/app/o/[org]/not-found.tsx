'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Inside an org: an unknown or malformed experiment id (INV-04 answers "not yours" the same way).
export default function OrgNotFound() {
  const org = usePathname().split('/')[2] ?? '';
  return (
    <main className="ho-main">
      <div className="ho-title">
        <h1 className="ho-h1">Not found</h1>
        <p className="ho-lead">There is no such page in this org, or it belongs to an org you are not a member of.</p>
      </div>
      <Link className="ho-link-btn" href={`/o/${org}/experiments`}>Back to experiments</Link>
    </main>
  );
}
