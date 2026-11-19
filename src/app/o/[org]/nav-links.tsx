'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Marks the current page with aria-current (the artboards' underline). Display only; the layout decides which links exist.
export function NavLinks({ links, label, className }: { links: { href: string; label: string; exact?: boolean }[]; label: string; className: string }) {
  // A labelled group inside the layout's one <nav> (foundation e2e specs expect a single navigation landmark).
  const path = usePathname();
  const current = links
    .filter((l) => (l.exact ? path === l.href : path === l.href || path.startsWith(`${l.href}/`)))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return (
    <div role="group" aria-label={label} className={className}>
      {links.map((l) => (
        <Link key={l.href} href={l.href} aria-current={current?.href === l.href ? 'page' : undefined}>
          {l.label}
        </Link>
      ))}
    </div>
  );
}
