import { SignIn } from "@clerk/nextjs";
import { readOptionalClerkPublishableKey } from "@/lib/env";

export default function SignInPage() {
  const hasClerk = Boolean(readOptionalClerkPublishableKey());

  return (
    <div className="auth-shell">
      <div className="auth-panel">
        <section className="auth-hero">
          <div className="auth-kicker">Crazy Agent</div>
          <div className="auth-brand">Welcome Back</div>
          <h1 className="auth-title">欢迎回来，继续你的长期记忆工作流</h1>
          <p className="auth-lead">
            登录后系统会自动恢复：你的对话历史、长期记忆、模型偏好、技能配置与统计数据。
            这不是一次性聊天工具，而是持续进化的个人 AI 伙伴。
          </p>
          <div className="auth-pill-row">
            <span className="auth-pill">历史上下文自动续接</span>
            <span className="auth-pill">支持上传文件与图片识别</span>
            <span className="auth-pill">联网结果可追溯</span>
          </div>
        </section>

        <section className="auth-card" style={{ display: "grid", placeItems: "center" }}>
          {hasClerk ? (
            <SignIn
              routing="path"
              path="/sign-in"
              signUpUrl="/sign-up"
              forceRedirectUrl="/workspace"
              fallbackRedirectUrl="/workspace"
            />
          ) : (
            <div className="card" style={{ width: "min(420px, 100%)", padding: 14 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>登录配置未就绪</div>
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
