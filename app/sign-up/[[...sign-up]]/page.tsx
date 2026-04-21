import { SignUp } from "@clerk/nextjs";
import { readOptionalClerkPublishableKey } from "@/lib/env";

export default function SignUpPage() {
  const hasClerk = Boolean(readOptionalClerkPublishableKey());

  return (
    <div className="auth-shell">
      <div className="auth-panel">
        <section className="auth-hero">
          <div className="auth-kicker">Crazy Agent</div>
          <div className="auth-brand">Build Your AI Memory</div>
          <h1 className="auth-title">创建账号，开启你的个人记忆操作系统</h1>
          <p className="auth-lead">
            注册后你将获得完整能力：长期记忆、模型兜底、联网证据、文件融合、流式输出，以及按账号持久化保存的所有历史数据。
          </p>
          <div className="auth-pill-row">
            <span className="auth-pill">全功能可用</span>
            <span className="auth-pill">账号级数据隔离</span>
            <span className="auth-pill">长期成长型助手</span>
          </div>
        </section>

        <section className="auth-card" style={{ display: "grid", placeItems: "center" }}>
          {hasClerk ? (
            <SignUp
              routing="path"
              path="/sign-up"
              signInUrl="/sign-in"
              forceRedirectUrl="/workspace"
              fallbackRedirectUrl="/workspace"
            />
          ) : (
            <div className="card" style={{ width: "min(420px, 100%)", padding: 14 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>注册配置未就绪</div>
              <div style={{ color: "#b7cae8", lineHeight: 1.7 }}>
                当前环境未读取到有效 Clerk 公钥，请检查 Vercel 环境变量
                <code> NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY </code>
                后重新部署。
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
