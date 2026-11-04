import { Navigation, Script, Widget } from 'scripting'
import { loadInitialState, SettingsPage } from './ui/settings'

async function main() {
  await Navigation.present(<SettingsPage initial={loadInitialState()} />)
  // 设置可能变了，让小组件用新设置重新渲染。缓存有效时不会联网。
  Widget.reloadAll()
  Script.exit()
}

main()
