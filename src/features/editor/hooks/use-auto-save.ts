import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useSettingsStore } from '@/features/editor/deps/settings'
import { createLogger } from '@/shared/logging/logger'
import { i18n } from '@/i18n'
import { recordEditorDiagnostic } from '@/infrastructure/editor-diagnostics'

const logger = createLogger('AutoSave')

interface UseAutoSaveOptions {
  /** Whether there are unsaved changes */
  isDirty: boolean
  /** Function to call when auto-saving */
  onSave: () => Promise<void>
  /** Whether auto-save is enabled (can be used to disable during export, etc.) */
  enabled?: boolean
  /** Delay before the first save after an edit. Keeps desktop projects safe on close. */
  debounceMs?: number
}

/**
 * Hook that automatically saves at the configured interval when there are unsaved changes.
 *
 * Reads `autoSaveInterval` from settings store (in minutes, 0 = disabled).
 * Only triggers save when `isDirty` is true to avoid unnecessary saves.
 *
 * @example
 * useAutoSave({
 *   isDirty,
 *   onSave: handleSave,
 * });
 */
export function useAutoSave({
  isDirty,
  onSave,
  enabled = true,
  debounceMs = 750,
}: UseAutoSaveOptions) {
  const autoSaveInterval = useSettingsStore((s) => s.autoSaveInterval)
  const isSavingRef = useRef(false)

  useEffect(() => {
    if (!enabled) {
      return
    }

    let idleCallbackId: number | undefined
    let debounceTimer: number | undefined

    const save = async (reason: 'debounced' | 'interval') => {
      if (isSavingRef.current || !isDirty) return
      isSavingRef.current = true
      const event = logger.startEvent('save')
      event.set('reason', reason)
      event.set('interval_min', autoSaveInterval)

      try {
        await onSave()
        event.success()
        recordEditorDiagnostic('autosave', 'info', 'Project timeline saved', { reason })
      } catch (error) {
        event.failure(error)
        recordEditorDiagnostic('autosave', 'error', 'Project timeline save failed', {
          reason,
          message: error instanceof Error ? error.message : String(error),
        })
        toast.error(i18n.t('editor.autoSave.failed'))
      } finally {
        isSavingRef.current = false
      }
    }

    // A five-minute recovery timer is not enough for a desktop editor: users
    // reasonably expect an edit to survive closing the window seconds later.
    // Save shortly after the first dirty state while retaining the configured
    // interval as a later safety net.
    if (isDirty) {
      debounceTimer = window.setTimeout(() => {
        void save('debounced')
      }, debounceMs)
    }

    // A zero interval disables periodic saves in Settings, but the short
    // post-edit save above still protects the current project from shutdown.
    const intervalMs = autoSaveInterval * 60 * 1000
    const intervalId = autoSaveInterval > 0 ? window.setInterval(() => {
      if (!isDirty || isSavingRef.current) return

      // Defer save to idle time so it doesn't interrupt active editing (e.g., dragging).
      // timeout ensures save still fires within 10s even under continuous activity.
      idleCallbackId = requestIdleCallback(() => void save('interval'), { timeout: 10_000 })
    }, intervalMs) : undefined

    return () => {
      if (debounceTimer !== undefined) window.clearTimeout(debounceTimer)
      if (intervalId !== undefined) window.clearInterval(intervalId)
      if (idleCallbackId !== undefined) cancelIdleCallback(idleCallbackId)
    }
  }, [autoSaveInterval, debounceMs, isDirty, onSave, enabled])
}
