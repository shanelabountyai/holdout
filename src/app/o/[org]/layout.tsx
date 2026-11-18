import { can } from '@/core/authz/permissions';
import { requireOrg } from '@/core/authz/guards';
import { db } from '@/core/db';
import { NavLinks } from './nav-links';
import './holdout.css';

// Navigation only. Layouts do not re-run on every navigation, so each page calls requireOrg itself.
// Main navigation as in the design artboards (Experiments, New experiment, Install snippet); the foundation's org and
// account pages stay one click away in the second row.
export default async function OrgLayout({ children, params }: { children: React.ReactNode; params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const org = await db.org.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { name: true } });
  const base = `/o/${ctx.slug}`;
  const settings = [
    { href: `${base}/projects`, label: 'Projects' },
    { href: `${base}/settings/members`, label: 'Members' },
    ...(can(ctx.role, 'audit.read') ? [{ href: `${base}/settings/audit`, label: 'Audit log' }, { href: `${base}/settings/security`, label: 'Security' }] : []),
    ...(ctx.role === 'owner' ? [{ href: `${base}/settings/sso`, label: 'SSO' }] : []), // sso
    ...(can(ctx.role, 'apikeys.manage') ? [{ href: `${base}/settings/apikeys`, label: 'API keys' }] : []), // apikeys
    ...(can(ctx.role, 'org.delete') ? [{ href: `${base}/settings/danger`, label: 'Export or delete' }] : []),
    { href: '/onboarding', label: 'Your orgs' },
    { href: '/account/security', label: 'Account' },
  ];
  return (
    <>
      <a href="#main" className="ho-skip">Skip to content</a>
      <header className="ho-header">
        <div className="ho-header-inner">
          <span className="ho-brand">Holdout <small>{org.name}</small></span>
          <NavLinks
            label="Main"
            className="ho-nav"
            links={[
              { href: `${base}/experiments`, label: 'Experiments' },
              { href: `${base}/experiments/new`, label: 'New experiment', exact: true },
              { href: `${base}/install`, label: 'Install snippet' },
            ]}
          />
        </div>
        <NavLinks label="Org and account" className="ho-subnav" links={settings} />
      </header>
      <div id="main">{children}</div>
    </>
  );
}
