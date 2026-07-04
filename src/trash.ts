import type { TrashFn } from './sessions.ts'

// The real side effect, isolated so deleteSession can take a fake in tests and
// this adapter stays out of the coverage gate.
export const trashPaths: TrashFn = async (paths) => {
  const { default: trash } = await import('trash') // lazy: only deletes need it
  await trash(paths)
}
