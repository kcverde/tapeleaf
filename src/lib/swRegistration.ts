export interface SwUpdateHandle {
  applyUpdate: () => void;
}

export function registerServiceWorker(callbacks: {
  onUpdateReady: (handle: SwUpdateHandle) => void;
  onControllerUpdated: () => void;
}): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  if (import.meta.env.DEV) return;

  const base = import.meta.env.BASE_URL || '/';
  const swUrl = `${base}sw.js`;
  // Only reload on controllerchange if a previous SW was already controlling this tab
  const hadControllerAtBoot = Boolean(navigator.serviceWorker.controller);

  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register(swUrl, { scope: base })
      .then((reg) => {
        const notifyWaiting = (worker: ServiceWorker | null) => {
          if (!worker) return;
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

        let notifiedControllerChange = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (!hadControllerAtBoot || notifiedControllerChange) return;
          notifiedControllerChange = true;
          // Let App defer reload until recorder is idle and all captures are saved
          callbacks.onControllerUpdated();
        });
      })
      .catch(() => {
        // Ignore SW registration failure on unsupported or non-HTTPS origins
      });
  });
}
