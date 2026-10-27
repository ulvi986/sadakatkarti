import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// StrictMode qəsdən yoxdur: dev rejimində effektləri iki dəfə işlədib kameranı ikiqat açır
createRoot(document.getElementById('root')!).render(<App />);
