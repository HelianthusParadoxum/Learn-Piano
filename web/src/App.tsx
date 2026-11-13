import { useEffect } from 'react';
import { player } from './lib/audio';
import { useRoute } from './lib/hooks';
import { HomePage } from './pages/HomePage';
import { PiecePage } from './pages/PiecePage';

export function App() {
  const route = useRoute();

  // stop the music when leaving a page
  useEffect(() => () => player.stop(), [route.page, route.pieceId]);

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#home">
          <span className="brand-logo" aria-hidden>
            <svg viewBox="0 0 64 64" width="28" height="28">
              <rect width="64" height="64" rx="14" fill="#4f46e5" />
              <rect x="12" y="16" width="10" height="32" rx="2" fill="white" />
              <rect x="27" y="16" width="10" height="32" rx="2" fill="white" />
              <rect x="42" y="16" width="10" height="32" rx="2" fill="white" />
              <rect x="19" y="16" width="6" height="19" rx="1.5" fill="#1e1b4b" />
              <rect x="34" y="16" width="6" height="19" rx="1.5" fill="#1e1b4b" />
            </svg>
          </span>
          <span className="brand-name">Learn Piano</span>
          <span className="brand-sub">разучивание по нотам</span>
        </a>
        <nav className="topnav">
          <a href="#home" className={route.page === 'home' ? 'active' : ''}>
            Мои пьесы
          </a>
        </nav>
      </header>
      <main className="content">
        {route.page === 'piece' && route.pieceId ? (
          <PiecePage key={route.pieceId} route={route} />
        ) : (
          <HomePage />
        )}
      </main>
      <footer className="footer">
        Распознавание нот — <a href="https://github.com/Audiveris/audiveris" target="_blank" rel="noreferrer">Audiveris</a>,
        нотная графика — <a href="https://opensheetmusicdisplay.org" target="_blank" rel="noreferrer">OpenSheetMusicDisplay</a>,
        звук — Salamander Grand Piano (Alexander Holm, CC-BY 3.0). Ваши ноты хранятся только в этом браузере.
      </footer>
    </div>
  );
}
