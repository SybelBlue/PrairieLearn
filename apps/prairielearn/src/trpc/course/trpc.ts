import { createExpressMiddleware } from '@trpc/server/adapters/express';

import { handleTrpcError } from '../../lib/trpc.js';

import { courseInstancesRouter } from './course-instances.js';
import { createContext, t } from './init.js';

export const courseRouter = t.router({
  courseInstances: courseInstancesRouter,
});

export type CourseRouter = typeof courseRouter;

export const courseTrpcRouter = createExpressMiddleware({
  router: courseRouter,
  createContext,
  onError: handleTrpcError,
});
