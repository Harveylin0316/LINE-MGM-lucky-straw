/**
 * 自動化流程 routes
 *
 * 階段 2：只有 cron 推進端點。
 *   POST /admin/flows/run   由 Netlify 排程每 5 分鐘呼叫（SCHEDULED_RUNNER_SECRET 驗證）
 *
 * 流程 CRUD（建立/編輯/啟用）會在階段 3 的流程編輯器加入。
 */

function registerAdminFlowsRoutes(app, deps) {
  const { flowEngine, authCore } = deps;

  // cron 推進（secret 驗證）
  app.post('/admin/flows/run', async (req, res) => {
    const expectedSecret = process.env.SCHEDULED_RUNNER_SECRET || '';
    const providedSecret = req.get('x-scheduler-secret') || '';
    if (!expectedSecret || providedSecret !== expectedSecret) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    try {
      const result = await flowEngine.run();
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error('flows run error:', err && (err.stack || err.message));
      return res.status(500).json({ ok: false, error: 'run_failed', detail: err && err.message });
    }
  });

  // admin 手動推進一次（方便階段 2 測試，不用等 cron）
  if (authCore && authCore.requireAdmin) {
    app.post('/admin/flows/run-now', authCore.requireAdmin, async (_req, res) => {
      try {
        const result = await flowEngine.run();
        return res.json({ ok: true, ...result });
      } catch (err) {
        return res.status(500).json({ ok: false, error: 'run_failed', detail: err && err.message });
      }
    });
  }
}

module.exports = { registerAdminFlowsRoutes };
