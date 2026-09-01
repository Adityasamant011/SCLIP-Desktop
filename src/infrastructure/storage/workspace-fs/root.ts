/**
 * Active workspace root owner.
 *
 * Holds the single FileSystemDirectoryHandle the entire app writes to.
 * `setWorkspaceRoot` is called once by WorkspaceGate after the user picks
 * (or re-grants) their workspace folder. Every storage module calls
 * `requireWorkspaceRoot()` to get the handle.
 *
 * Kept deliberately minimal — no React, no Zustand. This is the lowest
 * layer: pure getter/setter + permission-lost signaling.
 */

import { createLogger } from '@/shared/logging/logger'

const logger = createLogger('WorkspaceRoot')

let activeRoot: FileSystemDirectoryHandle | null = null

type PermissionLostListener = () => void
const permissionLostListeners = new Set<PermissionLostListener>()

export function setWorkspaceRoot(handle: FileSystemDirectoryHandle | null): void {
  activeRoot = handle
  if (handle) {
    logger.info(`Workspace root set: ${handle.name}`)
  } else {
    logger.info('Workspace root cleared')
  }
}

export function getWorkspaceRoot(): FileSystemDirectoryHandle | null {
  return activeRoot
}

/**
 * Return the active root or throw — every storage operation calls this.
 * Throwing is correct: if WorkspaceGate did its job, a storage op can
 * never run without an active root.
 */
export function requireWorkspaceRoot(): FileSystemDirectoryHandle {
  if (!activeRoot) {
    throw new Error(
      'Workspace root is not set. The app must render <WorkspaceGate> before any storage operation runs.',
    )
  }
  return activeRoot
}

/**
 * Subscribe to permission-lost events. Fires when any FS op catches
 * a NotAllowedError from the active root — UI can show a Reconnect modal.
 */
export function onPermissionLost(listener: PermissionLostListener): () => void {
  permissionLostListeners.add(listener)
  return () => permissionLostListeners.delete(listener)
}

export function notifyPermissionLost(): void {
  logger.warn('Permission lost on workspace root')
  for (const listener of permissionLostListeners) {
    try {
      listener()
    } catch (error) {
      logger.warn('permission-lost listener threw', error)
    }
  }
}

/**
 * Initialize the Tauri workspace root synchronously.
 * Can be called from route beforeLoad hooks to ensure workspace is ready.
 */
export async function initializeWorkspace(): Promise<boolean> {
  return ensureTauriWorkspace()
}

let tauriInitPromise: Promise<FileSystemDirectoryHandle | null> | null = null

/**
 * Ensure the Tauri workspace root is initialized.
 *
 * Tries to call the Tauri invoke API. If not in Tauri or invoke fails,
 * returns false. This is called from route beforeLoad hooks as a safety
 * net, and also from WorkspaceGate's useEffect.
 *
 * KEY: We don't check `__TAURI_INTERNALS__` first — we just try `invoke`
 * directly. If it works, we're in Tauri. If it throws, we're not.
 * This is more robust than checking for the global, which might be set
 * at a different time depending on the Tauri version/configuration.
 */
export async function ensureTauriWorkspace(): Promise<boolean> {
  // If already set, we're done
  if (activeRoot) return true

  // Cache the init promise so concurrent calls share the same result
  if (!tauriInitPromise) {
    tauriInitPromise = (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        
        // First check if we have a saved workspace path
        const savedPath: string | null = await invoke('get_workspace_path')
        let workspacePath = (savedPath || '').trim()
        
        // If no saved path, prompt user to pick one
        if (!workspacePath) {
          const picked: string = await invoke('pick_workspace')
          workspacePath = (picked || '').trim()
        }

        
        if (!workspacePath) {
          console.error('[FreeCut] pick_workspace returned empty path')
          return null
        }

        const { TauriDirectoryHandle } = await import(
          '@/infrastructure/tauri-fs-polyfill'
        )
        const handle = new TauriDirectoryHandle(
          workspacePath.split('/').pop() || 'workspace',
          workspacePath,
        ) as unknown as FileSystemDirectoryHandle

        // Bootstrap the workspace (create README, marker, etc.)
        try {
          const { bootstrapWorkspace } = await import(
            '@/infrastructure/storage/workspace-fs/bootstrap'
          )
          await bootstrapWorkspace(handle)
        } catch (e) {
          console.warn('[FreeCut] bootstrapWorkspace failed:', e)
        }

        return handle
      } catch (error) {
        console.error('[FreeCut] ensureTauriWorkspace failed:', error)
        return null
      }
    })()
  }

  const handle = await tauriInitPromise
  if (handle) {
    setWorkspaceRoot(handle)
    return true
  }
  // Clear the cached promise on failure so subsequent attempts can retry
  tauriInitPromise = null
  return false
}
