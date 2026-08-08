import { Router, type Request, type Response } from "express";

const router: import('express').Router = Router();
const startedAt = Date.now();

router.get("/health", (_req: Request, res: Response): void => {
  res.json({ ok: true, uptime: Math.floor((Date.now() - startedAt) / 1000) });
});

export default router;
