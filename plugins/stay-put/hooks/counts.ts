export type Count = { caught: number; fixed: number }

const isCount = (value: unknown): value is Count =>
  typeof value === 'object' &&
  value !== null &&
  'caught' in value &&
  'fixed' in value &&
  typeof value.caught === 'number' &&
  typeof value.fixed === 'number'

/** A stored value as a count; anything else reads as zero. */
export const toCount = (stored: unknown): Count => (isCount(stored) ? stored : { caught: 0, fixed: 0 })

export const addCount = (stored: unknown, delta: Partial<Count>): Count => {
  const count = toCount(stored)
  return { caught: count.caught + (delta.caught ?? 0), fixed: count.fixed + (delta.fixed ?? 0) }
}

export const sumCounts = (stored: readonly unknown[]): Count =>
  stored.reduce<Count>((total, value) => addCount(total, toCount(value)), { caught: 0, fixed: 0 })
