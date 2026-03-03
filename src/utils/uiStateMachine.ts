export type UiState = 'unconfigured' | 'loading' | 'ready' | 'error';

const allowedTransitions: Record<UiState, UiState[]> = {
  unconfigured: ['loading'],
  loading: ['ready', 'error', 'unconfigured'],
  ready: ['loading', 'error', 'unconfigured'],
  error: ['loading', 'unconfigured'],
};

export function isUiStateTransitionAllowed(
  fromState: UiState,
  toState: UiState
): boolean {
  if (fromState === toState) {
    return true;
  }

  return allowedTransitions[fromState].includes(toState);
}