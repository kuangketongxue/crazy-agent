export default function HomePage() {
  return (
    <div className="auth-shell">
      <div className="auth-panel">
        <section className="auth-hero">
          <div className="auth-kicker">Crazy Agent</div>
          <div className="auth-brand">Personal Memory OS</div>
          <h1 className="auth-title">长期记忆驱动的个人 AI 工作台</h1>
          <p className="auth-lead">
            主打「个人长期记忆 + 完全免费 + 多模型自动兜底 + 联网可追溯来源 + 文件融合 + 实时信息解析」。
            一次设置后，系统会持续记住你的目标、偏好与工作节奏，让每次对话都更快、更准、更省心。
          </p>
          <div className="auth-pill-row">
            <span className="auth-pill">完全免费可用</span>
            <span className="auth-pill">长期记忆自动沉淀</span>
            <span className="auth-pill">OpenRouter / NVIDIA 双通道兜底</span>
            <span className="auth-pill">上传文件 + 联网证据融合</span>
          </div>
          <div style={{ marginTop: 22, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <a
              href="/sign-in"
              style={{
                borderRadius: 12,
                padding: "10px 16px",
                background: "linear-gradient(115deg, #ff9d3f 0%, #ffd678 50%, #64dfff 100%)",
                color: "#031723",
                textDecoration: "none",
                fontWeight: 700,
              }}
            >
              登录开始
            </a>
            <a
              href="/sign-up"
              style={{
                borderRadius: 12,
                padding: "10px 16px",
                border: "1px solid rgba(251,187,111,0.42)",
                background: "rgba(23,26,35,0.66)",
                color: "#ffe2bf",
                textDecoration: "none",
                fontWeight: 700,
              }}
            >
              新账号注册
            </a>
          </div>
          <div style={{ marginTop: 10, color: "#9dc0e8", fontSize: 13 }}>
            已登录用户可直接访问 <a href="/workspace" style={{ color: "#8ee7ff" }}>/workspace</a>
          </div>
        </section>
        <section className="auth-card">
          <h2 style={{ margin: "0 0 8px", fontSize: 30, color: "#ffd095" }}>开始使用</h2>
          <p style={{ marginTop: 0, color: "#d7e7ff", lineHeight: 1.78, fontSize: 15 }}>
            登录后默认进入 /workspace。你的 API Key、长期记忆、Token 统计、对话记录全部跟账号绑定且持久化保存。
            你可以在设置中随时调整联网策略、长期要求和记忆内容，系统会实时生效。
          </p>
        </section>
      </div>
    </div>
  );
}

