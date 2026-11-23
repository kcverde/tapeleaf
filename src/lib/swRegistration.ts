export interface SwUpdateHandle {
  applyUpdate: () => void;
}

export type SwRegistrationStatus = 'ready' | 'unsupported' | 'error';

export function registerServiceWorker(callbacks: {
  onUpdateReady: (handle: SwUpdateHandle) => void;
  onControllerUpdated: () => void;
  onStatusChange?: (status: SwRegistrationStatus, message?: string) => void;
}): () => void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    callbacks.onStatusChange?.('unsupported');
    return () => {};
  }
  if (import.meta.env.DEV) {
    return () => {};
  }

  const base = import.meta.env.BASE_URL || '/';
  const swUrl = `${base}sw.js`;
  // Only reload on controllerchange if a previous SW was already controlling this tab
  const hadControllerAtBoot = Boolean(navigator.serviceWorker.controller);

  let disposed = false;
  let notifiedControllerChange = false;

  const onControllerChange = () => {
    if (disposed || !hadControllerAtBoot || notifiedControllerChange) return;
    notifiedControllerChange = true;
    // Let App defer reload until recorder is idle and all captures are saved
    callbacks.onControllerUpdated();
  };

  navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

  const doRegister = () => {
    if (disposed) return;
    void navigator.serviceWorker
      .register(swUrl, { scope: base })
      .then((reg) => {
        if (disposed) return;
        callbacks.onStatusChange?.('ready');

        const notifyWaiting = (worker: ServiceWorker | null) => {
          if (!worker || disposed) return;
          callbacks.onUpdateReady({
            applyUpdate: () => {
              worker.postMessage({ type: 'SKIP_WAITING' });
            },
          });
        };

        if (reg.waiting) {
          notifyWaiting(reg.waiting);
        }

        reg.addEventListener('updatefound', () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              notifyWaiting(reg.waiting || installing);
            }
          });
        });
      })
      .catch((err) => {
        if (disposed) return;
        callbacks.onStatusChange?.(
          'error',
          err instanceof Error ? err.message : 'Offline service worker could not register.',
        );
      });
  };

  if (document.readyState === 'complete') {
    doRegister();
  } else {
    window.addEventListener('load', doRegister, { once: true });
  }

  return () => {
    disposed = true;
    window.removeEventListener('load', doRegister);
    navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
  };
}
