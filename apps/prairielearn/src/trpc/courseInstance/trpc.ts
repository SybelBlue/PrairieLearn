import { createExpressMiddleware } from '@trpc/server/adapters/express';

import { handleTrpcError } from '../../lib/trpc.js';

import { gradebookRouter } from './gradebook.js';
import { createContext, t } from './init.js';
import { instanceAdminSettingsRouter } from './instance-admin-settings.js';
import { publishingExtensionsRouter } from './publishing-extensions.js';
import { studentLabelsRouter } from './student-labels.js';
import { studentsRouter } from './students.js';

export const courseInstanceRouter = t.router({
  gradebook: gradebookRouter,
  instanceAdminSettings: instanceAdminSettingsRouter,
  publishingExtensions: publishingExtensionsRouter,
  studentLabels: studentLabelsRouter,
  students: studentsRouter,
});

export type CourseInstanceRouter = typeof courseInstanceRouter;

export const courseInstanceTrpcRouter = createExpressMiddleware({
  router: courseInstanceRouter,
  createContext,
  onError: handleTrpcError,
});
