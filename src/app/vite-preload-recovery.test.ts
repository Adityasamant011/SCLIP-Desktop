import { describe, expect, it } from 'vitest'

import {
  claimDevVitePreloadRecovery,
  DEV_VITE_PRELOAD_RECOVERY_COOLDOWN_MS,
} from './vite-preload-recovery'

function createStorage(initialValue: string | null = null) {
  let value = initialValue
  return {
    getItem: () => value,
    setItem: (_key: string, nextValue: string) => {
      value = nextValue
    },
  }
}

describe('claimDevVitePreloadRecovery', () => {
  it('allows one recovery and suppresses an immediate reload loop', () => {
    const storage = createStorage()
    const now = 1_000_000

    expect(claimDevVitePreloadRecovery(storage, now)).toBe(true)
    expect(claimDevVitePreloadRecovery(storage, now + 1)).toBe(false)
    expect(
      claimDevVitePreloadRecovery(storage, now + DEV_VITE_PRELOAD_RECOVERY_COOLDOWN_MS),
    ).toBe(true)
  })

  it('recovers when session storage is unavailable', () => {
    const storage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }

    expect(claimDevVitePreloadRecovery(storage)).toBe(true)
  })
})
