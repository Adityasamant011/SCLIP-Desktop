const videoElementsByItemId = new Map<string, Set<HTMLVideoElement>>()

function getOrCreateItemElements(itemId: string): Set<HTMLVideoElement> {
  const existing = videoElementsByItemId.get(itemId)
  if (existing) return existing

  const next = new Set<HTMLVideoElement>()
  videoElementsByItemId.set(itemId, next)
  return next
}

export function registerDomVideoElement(itemId: string, element: HTMLVideoElement): void {
  getOrCreateItemElements(itemId).add(element)
}

export function unregisterDomVideoElement(itemId: string, element: HTMLVideoElement): void {
  const itemElements = videoElementsByItemId.get(itemId)
  if (!itemElements) return

  itemElements.delete(element)
  if (itemElements.size === 0) {
    videoElementsByItemId.delete(itemId)
  }
}

export function getBestDomVideoElementForItem(itemId: string): HTMLVideoElement | null {
  const itemElements = videoElementsByItemId.get(itemId)
  if (!itemElements || itemElements.size === 0) {
    return null
  }

  let best: HTMLVideoElement | null = null
  let bestReadyState = 0

  for (const element of itemElements) {
    if (!element.isConnected) {
      itemElements.delete(element)
      continue
    }

    if (element.readyState > bestReadyState && element.videoWidth > 0) {
      best = element
      bestReadyState = element.readyState
    }
  }

  if (itemElements.size === 0) {
    videoElementsByItemId.delete(itemId)
  }

  return best
}

export function getAllConnectedDomVideoElements(): HTMLVideoElement[] {
  const elements: HTMLVideoElement[] = []
  for (const set of videoElementsByItemId.values()) {
    for (const el of set) {
      if (el.isConnected) {
        elements.push(el)
      }
    }
  }
  return elements
}

/**
 * D2 DIAGNOSTIC VARIANT:
 * Wait for active video element(s) to present their first frame via requestVideoFrameCallback
 * before establishing transport start epoch.
 */
export function waitForActiveVideoPresentation(timeoutMs = 1200): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(true)
  const elements = getAllConnectedDomVideoElements()
  if (elements.length === 0) {
    return Promise.resolve(true)
  }

  return new Promise((resolve) => {
    let resolved = false
    let timer: number | null = null

    const onDone = () => {
      if (resolved) return
      resolved = true
      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
      resolve(true)
    }

    timer = window.setTimeout(onDone, timeoutMs)

    for (const el of elements) {
      if ('requestVideoFrameCallback' in el) {
        el.requestVideoFrameCallback(() => {
          onDone()
        })
      } else {
        el.addEventListener('timeupdate', onDone, { once: true })
      }
    }
  })
}

export function clearDomVideoElementRegistry(): void {
  videoElementsByItemId.clear()
}

