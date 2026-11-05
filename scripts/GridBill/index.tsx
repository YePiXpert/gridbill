import { Navigation, Script, Widget } from 'scripting'
import { DetailPage, loadDetailState } from './ui/detail'

async function main() {
  await Navigation.present(<DetailPage initial={loadDetailState()} />)
  // 设置可能变了，让小组件用新设置重新渲染。缓存有效时不会联网。
  Widget.reloadAll()
  Script.exit()
}

main()
