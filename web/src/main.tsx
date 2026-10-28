import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { wireAccountSync } from './lib/accountSync.ts';
import { initAuth } from './lib/auth.ts';
import './index.css';

wireAccountSync();
void initAuth();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
