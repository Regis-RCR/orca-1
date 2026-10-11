import type { AppState } from '../types'

/** The composition inputs of a store that never saw a program-status slot. */
export const NO_PROGRAM_STATUS: Pick<
  AppState,
  'programStatusByPaneKey' | 'programStatusPreferred' | 'programStatusEpoch'
> = Object.freeze({
  programStatusByPaneKey: Object.freeze({}),
  programStatusPreferred: false,
  programStatusEpoch: 0
})
