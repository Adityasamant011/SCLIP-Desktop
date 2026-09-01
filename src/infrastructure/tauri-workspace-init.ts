/**
 * Synchronous workspace root initialization for Tauri.
 *
 * This module runs at import time (in main.tsx) and immediately sets the
 * workspace root to a TauriDirectoryHandle pointing at ~/Documents/Sclip-Workspace.
 *
 * This eliminates ALL race conditions — the workspace root is set before ANY
 * React code runs, before any route loader fires, before anything.
 *
 * In browser mode, this is a no-op (isTauri() returns false, no-op).
 * In Tauri mode, the invoke('pick_workspace') call is synchronous enough
 * (it's a simple path operation in Rust) that we can await it during
 * module initialization.
 */

import { setWorkspaceRoot } from '@/infrastructure/storage/workspace-fs/root'
import { TauriDirectoryHandle } from '@/infrastructure/tauri-fs-polyfill'

// Determine if we're in Tauri by checking for the __TAURI_INTERNALS__ global
function isTauri(): boolean {
  return typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__ !== undefined
}

export async function initTauriWorkspaceRoot(): Promise<boolean> {
  if (!isTauri()) return false
  if (typeof window === 'undefined') return false

  try {
    // We need to handle the case where invoke throws (not in Tauri, or
    // the command isn't registered). Use a try/catch around the dynamic import.
    const { invoke } = await import('@tauri-apps/api/core')
    const workspacePath: string = await invoke('pick_workspace')
    if (!workspacePath) {
      console.error('[Sclip] pick_workspace returned empty path')
      return false
    }

    const handle = new TauriDirectoryHandle(
      workspacePath.split('/').pop() || 'workspace',
      workspacePath,
    ) as unknown as FileSystemDirectoryHandle

    // Bootstrap the workspace (create README, index.json, etc.)
    try {
      const { bootstrapWorkspace } = await import(
        '@/infrastructure/storage/workspace-fs/bootstrap'
      )
      await bootstrapWorkspace(handle)
    } catch (e) {
      console.warn('[Sclip] bootstrapWorkspace failed (non-fatal):', e)
    }

    setWorkspaceRoot(handle)
    return true
  } catch (error: any) {
    console.error('[Sclip] initTauriWorkspaceRoot failed:', error?.message || error)
    return false
  }
}
