import { createRoot } from 'react-dom/client';
import '@pollar/react/styles.css';
import App from './App.tsx';
import { AuthProvider } from './contexts/AuthContext.tsx';
import { PollarBridgeProvider } from './contexts/PollarBridgeProvider.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <AuthProvider>
    <PollarBridgeProvider>
      <App />
    </PollarBridgeProvider>
  </AuthProvider>
);
