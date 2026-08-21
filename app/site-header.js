import { Activity, LayoutDashboard, SlidersHorizontal } from "lucide-react"

const NAV_ITEMS = [
  ["workspace", "/", "转换工作台", "图纸识别与排板", LayoutDashboard],
  ["settings", "/settings", "参数预设", "项目规则库", SlidersHorizontal],
]

export default function SiteHeader({ active }) {
  return (
    <aside className="flex w-full shrink-0 flex-col bg-[#111923] text-white lg:sticky lg:top-0 lg:h-screen lg:w-[264px]">
      <div className="flex h-[76px] items-center gap-3 border-b border-white/10 px-5 lg:h-auto lg:px-7 lg:py-7">
        <span className="grid size-10 place-items-center bg-[#ff6b2c] font-mono text-sm font-black tracking-[-.08em] text-white">CM</span>
        <span className="leading-tight">
          <strong className="block text-[15px] tracking-wide">CAD Master</strong>
          <small className="mt-1 block text-[10px] tracking-[.16em] text-slate-400">自动排板控制台</small>
        </span>
      </div>

      <nav className="flex gap-2 overflow-x-auto p-3 lg:flex-1 lg:flex-col lg:px-4 lg:py-7" aria-label="主要导航">
        {NAV_ITEMS.map(([id, href, label, caption, Icon]) => (
          <a
            key={id}
            href={href}
            className={`group flex min-w-40 items-center gap-3 px-4 py-3.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#ff6b2c] ${active === id ? "bg-white text-[#111923]" : "text-slate-300 hover:bg-white/5 hover:text-white"}`}
          >
            <Icon className={`size-5 shrink-0 ${active === id ? "text-[#ff6b2c]" : "text-current"}`} strokeWidth={1.8} aria-hidden="true" />
            <span>
              <strong className="block text-sm font-semibold">{label}</strong>
              <small className="mt-0.5 hidden text-[10px] text-slate-500 lg:block">{caption}</small>
            </span>
          </a>
        ))}
      </nav>

      <div className="hidden border-t border-white/10 p-6 lg:block">
        <div className="flex items-center gap-2 text-[11px] text-slate-300">
          <Activity className="size-4 text-emerald-400" strokeWidth={2} aria-hidden="true" />
          本地处理服务正常
        </div>
        <p className="mt-3 font-mono text-[9px] leading-5 tracking-[.12em] text-slate-600">LOCAL WORKSPACE<br />CAD PROCESSING SYSTEM</p>
      </div>
    </aside>
  )
}
