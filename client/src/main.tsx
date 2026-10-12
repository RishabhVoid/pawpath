import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const isPetPreview = window.location.pathname.replace(/\/$/, '') === '/pets';
const PetsPreview = React.lazy(() => import('./PetsPreview.js'));

createRoot(document.getElementById('root')!).render(<React.StrictMode>{isPetPreview ? <React.Suspense fallback={null}><PetsPreview /></React.Suspense> : <App />}</React.StrictMode>);
if ('serviceWorker' in navigator && import.meta.env.PROD) void navigator.serviceWorker.register('/sw.js');
