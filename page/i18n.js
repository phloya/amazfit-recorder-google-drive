// Язык интерфейса по языку часов: русский (код 4 в Zepp OS) или английский для всех остальных.
import { getLanguage } from '@zos/settings'

let ru = false
try {
  ru = getLanguage() === 4
} catch (e) {}

export const RU = ru

// L('по-русски', 'in English')
export function L(textRu, textEn) {
  return RU ? textRu : textEn
}

// «ещё 2 нажатия — стоп» / «2 more to stop»
export function pressesLeft(n) {
  if (!RU) return n + ' more to stop'
  return 'ещё ' + n + (n === 1 ? ' нажатие' : ' нажатия') + ' — стоп'
}
