import { TEXT_DEFAULTS } from '@/shared/typography/text-style'
import type { TextItem, TextSpan, TimelineItem } from '@/types/timeline'
import type { Transform } from '../types/gizmo'

export interface GroupScaledTextProperties {
  fontSize: number
  letterSpacing: number
  textPadding: number
  backgroundRadius: number
  textShadow?: TextItem['textShadow']
  stroke?: TextItem['stroke']
  textSpans?: TextSpan[]
  textStyleScale?: number
}

function scaleTextProperties(item: TextItem, factor: number): GroupScaledTextProperties {
  return {
    fontSize: (item.fontSize ?? TEXT_DEFAULTS.fontSize) * factor,
    letterSpacing: (item.letterSpacing ?? TEXT_DEFAULTS.letterSpacing) * factor,
    textPadding: (item.textPadding ?? TEXT_DEFAULTS.textPadding) * factor,
    backgroundRadius: (item.backgroundRadius ?? 0) * factor,
    textShadow: item.textShadow
      ? {
          ...item.textShadow,
          offsetX: item.textShadow.offsetX * factor,
          offsetY: item.textShadow.offsetY * factor,
          blur: item.textShadow.blur * factor,
        }
      : undefined,
    stroke: item.stroke
      ? {
          ...item.stroke,
          width: item.stroke.width * factor,
        }
      : undefined,
    textSpans: item.textSpans?.map((span) => ({
      ...span,
      fontSize: span.fontSize === undefined ? undefined : span.fontSize * factor,
      letterSpacing: span.letterSpacing === undefined ? undefined : span.letterSpacing * factor,
    })),
    textStyleScale: item.textStyleScale === undefined ? undefined : item.textStyleScale * factor,
  }
}

/**
 * Build the non-transform updates that make text content participate in a
 * Figma-style group resize. Media content already follows its resized wrapper;
 * text metrics are authored independently and therefore need to be scaled too.
 */
export function buildGroupScaledTextProperties(
  items: readonly TimelineItem[],
  startTransforms: ReadonlyMap<string, Transform>,
  nextTransforms: ReadonlyMap<string, Transform>,
): Map<string, GroupScaledTextProperties> {
  const updates = new Map<string, GroupScaledTextProperties>()

  for (const item of items) {
    if (item.type !== 'text') continue
    const start = startTransforms.get(item.id)
    const next = nextTransforms.get(item.id)
    if (!start || !next || start.width <= 0) continue

    const factor = next.width / start.width
    if (!Number.isFinite(factor) || factor <= 0) continue
    updates.set(item.id, scaleTextProperties(item, factor))
  }

  return updates
}
