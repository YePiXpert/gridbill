import { Widget } from 'scripting'
import { createService, type WidgetModel } from './lib/service'
import { scriptingTransport } from './lib/transport'
import { WidgetRoot } from './ui/widget-views'

async function main() {
  let model: WidgetModel
  try {
    model = await createService(scriptingTransport).loadWidgetModel(Widget.parameter)
  } catch {
    model = { state: 'error', message: '读取数据时出错，请打开脚本查看', nextRefresh: new Date(Date.now() + 3600 * 1000) }
  }
  // present 之后上下文立即销毁，所有数据必须在这之前准备好。
  Widget.present(<WidgetRoot model={model} />, { policy: 'after', date: model.nextRefresh })
}

main()
