import { lazy, Suspense } from 'react';
import CustomerPage from './pages/CustomerPage';

// Panellər (QR skaner və qrafiklərlə) ayrıca yüklənir — müştərilər onları endirmir
const PanelPage = lazy(() => import('./pages/PanelPage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));

const loading = <div className="wrap"><div className="panel muted center">Yüklənir…</div></div>;

export default function App() {
  const { pathname } = window.location;
  if (pathname.startsWith('/panel')) return <Suspense fallback={loading}><PanelPage /></Suspense>;
  if (pathname.startsWith('/admin')) return <Suspense fallback={loading}><AdminPage /></Suspense>;
  const token = pathname.startsWith('/c/') ? decodeURIComponent(pathname.slice(3)) : null;
  const slug = pathname.startsWith('/k/') ? decodeURIComponent(pathname.slice(3)).replace(/\/$/, '') : null;
  return <CustomerPage urlToken={token} urlSlug={slug} />;
}
