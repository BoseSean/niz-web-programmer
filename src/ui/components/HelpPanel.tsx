import { Dialog } from './Dialog'
import './HelpPanel.css'

interface Props {
  onClose: () => void
  /** Whether the 通信日志 drawer is shown; the toggle at the end of section 5 needs onToggleLog. */
  logVisible?: boolean
  onToggleLog?: () => void
}

export function HelpPanel({ onClose, logVisible = false, onToggleLog }: Props) {
  return (
    <Dialog title="使用说明" onClose={onClose} wide>
      <div className="help">
        <section>
          <h3><span className="help-no">1</span>连接</h3>
          <ul>
            <li>使用桌面版 <b>Chrome</b> 或 <b>Edge</b>，通过 HTTPS 或 localhost 打开本页。</li>
            <li><b>先关闭原厂 KB84 软件</b>，它会独占键盘的改键接口。</li>
            <li>点“连接键盘”，在弹出的列表里选择 84EC-S。没有键盘时可以点“使用模拟键盘”熟悉流程。</li>
            <li>授权过一次之后，打开本页或重新插上键盘会<b>自动连接</b>（不需要时可以关掉“自动连接”）。提示“键盘被占用”时，关掉 KB84 或其他标签页后点“重试”。</li>
          </ul>
        </section>
        <section>
          <h3><span className="help-no">2</span>M 灯与编程模式</h3>
          <ul>
            <li><b>长按 Fn+F12 约 2 秒</b>切换模式：F12 上的 M 灯亮 = 编程模式，用键盘里的键位（你写入的）；M 灯灭 = 办公模式，用出厂键位。</li>
            <li>读取时：办公模式（M 灯灭）下只能读到出厂键位，编程模式（M 灯亮）下读到的才是键盘里的键位。<b>读取前请让 M 灯亮着。</b></li>
            <li>写入时：不论哪种模式，都写到键盘里的键位；要用上它们，需要切换到编程模式。</li>
          </ul>
        </section>
        <section>
          <h3><span className="help-no">3</span>读取 → 编辑 → 写入</h3>
          <ul>
            <li><b>读取键盘</b>：读出两层全部键位。</li>
            <li><b>编辑</b>：点键盘图上的键，在键位设置里选择动作。按 <kbd>1</kbd> / <kbd>2</kbd> 切换基础层 / Fn 层，<kbd>Ctrl</kbd>+<kbd>Z</kbd> 撤销，<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> 重做。</li>
            <li>红色键帽 = 与出厂不同；右上角的墨点 = 未写入；斜纹 = 设置有误，不能写入；右下角小字 = 按住 Fn 时的功能。</li>
            <li><b>写入键盘</b>：一次写入两层全部键位，写完自动读回校验。有错误时不能写入。</li>
          </ul>
        </section>
        <section>
          <h3><span className="help-no">4</span>动作库、方案、按键测试</h3>
          <ul>
            <li><b>动作库</b>：把组合键、宏、<span title="KB84 中叫“模拟击键”">连发</span>起名保存（对应 KB84 的预定义列表），在编辑器里点“存入动作库”“从动作库选择”。动作库随 .json 和 .pro 一起导出。</li>
            <li><b>方案</b>：把页面上的键位存在这个浏览器里。<b>每次写入前会自动备份</b>键盘里原来的键位（没读取过会先读一次；读不到就这次不备份），可以在写入结果里点“改回写入前的键位”，或在“方案 → 自动备份”里载入到页面。</li>
            <li><b>方案 → 导出 / 导入文件</b>：.json 保存全部内容，KB84 .pro 可在原厂软件中打开；也可以把文件直接拖到页面上导入。</li>
            <li><b>按键测试</b>：显示电脑实际收到的按键并在键盘图上亮起，用来检查写入的键位。测试时编辑快捷键暂停，点上方的“键位设置”标签或连按两次 <kbd>Esc</kbd> 退出。</li>
            <li><b>键盘图旁的“⋯”菜单 → 全部清空</b>：两层全部设为“无”，默认保留 Fn 和模式切换；同一个菜单里还有“全部改回出厂键位”。都可以撤销。</li>
          </ul>
        </section>
        <section>
          <h3><span className="help-no">5</span>出了问题？</h3>
          <ul>
            <li><b>键盘复位</b>：同时按住 <kbd>Esc</kbd> + <kbd>Delete</kbd> + <kbd>左 Ctrl</kbd> + <kbd>→</kbd>（键盘四个角）约 5 秒，恢复出厂键位。</li>
            <li>键盘没有回应：关闭 KB84 软件和其他连接了键盘的标签页，重新插拔后再试。</li>
            <li>基础层至少保留一个 Fn 键，并且 Fn 层的 F12 最好保持“办公/编程模式切换”，否则可能进不了 Fn 层，或切不回办公模式。</li>
            <li>本工具<b>不支持固件升级</b>，也不会发送任何固件或灯光命令。</li>
          </ul>
          {onToggleLog && (
            <p className="help-tools">
              <button type="button" className="btn btn-sm" onClick={onToggleLog}>
                {logVisible ? '隐藏通信日志' : '显示通信日志（排查问题时用）'}
              </button>
            </p>
          )}
        </section>
      </div>
    </Dialog>
  )
}
