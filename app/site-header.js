export default function SiteHeader({ active }) {
  return (
    <header className="topbar">
      <a className="brand" href="/" aria-label="CAD Master 首页">
        <span className="brand-mark">CM</span>
        <span>
          <strong>CAD Master</strong>
          <small>洁净室自动排板</small>
        </span>
      </a>
      <div className="topbar-tools">
        <nav className="primary-nav" aria-label="主要导航">
          <a className={active === "workspace" ? "is-active" : ""} href="/">
            转换工作台
          </a>
          <a className={active === "settings" ? "is-active" : ""} href="/settings">
            预设设置
          </a>
        </nav>
        <div className="system-state">
          <span />
          本地处理服务
        </div>
      </div>
    </header>
  )
}
