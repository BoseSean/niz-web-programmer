import { keyByNo } from '../../device/layout'
import type { LayerId } from '../../device/types'
import { slotToAction } from '../../format/compile'
import { diffTables } from '../../protocol/codec'
import type { SlotTable } from '../../protocol/slots'
import { describeAction, LAYER_ZH } from './describe'

export interface ChangeRow {
  layer: LayerId
  keyId: string
  where: string
  from: string
  to: string
}

/** Slots that differ between `from` and `to`, described in Chinese. */
export function changeRows(from: SlotTable, to: SlotTable): ChangeRow[] {
  return diffTables(from, to).map((d) => {
    const key = keyByNo(d.keyNo)!
    return {
      layer: d.layer,
      keyId: key.id,
      where: `${LAYER_ZH[d.layer]} · ${key.label}`,
      from: describeAction(slotToAction(d.a)),
      to: describeAction(slotToAction(d.b)),
    }
  })
}
