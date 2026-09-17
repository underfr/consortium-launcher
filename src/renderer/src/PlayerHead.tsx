import type { AccountSummary } from '../../shared/types'

/**
 * The player's head next to their name: an 8x8 PNG (face with the hat layer already composited by
 * the main process) shown at 32 px with nearest-neighbour scaling, so the texels stay crisp.
 * Decorative: the name next to it carries the meaning for assistive tech.
 */
export function PlayerHead({ account, size = 32 }: { account: AccountSummary; size?: number }): React.JSX.Element {
  return <img className="head" src={account.headDataUrl} width={size} height={size} alt="" aria-hidden="true" draggable={false} />
}
