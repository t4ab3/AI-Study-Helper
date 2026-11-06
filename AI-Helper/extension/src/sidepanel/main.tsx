import { createRoot } from 'react-dom/client';
import { App } from './App';
import { log } from '../shared/logger';
import './styles.css';

window.addEventListener('error', (e) => log('error', 'panel', e.message, e.error));
window.addEventListener('unhandledrejection', (e) => log('error', 'panel', 'unhandled rejection', e.reason));

createRoot(document.getElementById('root')!).render(<App />);
