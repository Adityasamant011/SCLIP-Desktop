export const DEV_VITE_PRELOAD_RECOVERY_COOLDOWN_MS = 10_000

const DEV_VITE_PRELOAD_RECOVERY_KEY = 'freecut-dev-vite-preload-recovery-at'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

/**
 * Claim a single development reload after Vite invalidates optimized dependency URLs.
 * Session storage prevents a broken dev server from trapping the editor in a reload loop;
 * storage failures still allow the current page's in-memory guard to recover once.
 */
export function claimDevVitePreloadRecovery(
  storage: StorageLike,
  now = Date.now(),
): boolean {
  try {
    const lastRecoveryAt = Number(storage.getItem(DEV_VITE_PRELOAD_RECOVERY_KEY))
    if (
      Number.isFinite(lastRecoveryAt) &&
      lastRecoveryAt > 0 &&
      now - lastRecoveryAt < DEV_VITE_PRELOAD_RECOVERY_COOLDOWN_MS
    ) {
      return false
    }
    storage.setItem(DEV_VITE_PRELOAD_RECOVERY_KEY, String(now))
  } catch {
    // Restricted storage should not disable recovery; the caller also keeps an in-memory guard.
  }
  return true
}
