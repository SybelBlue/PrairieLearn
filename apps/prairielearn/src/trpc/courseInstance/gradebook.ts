import { z } from 'zod';

import { loadSqlEquiv, queryRows } from '@prairielearn/postgres';
import { IdSchema } from '@prairielearn/zod';

import { setAssessmentInstanceScore } from '../../lib/assessment.js';
import { checkAssessmentInstanceBelongsToCourseInstance } from '../../lib/course.js';
import {
  AssessmentInstanceScoreResultSchema,
  GradebookRowSchema,
} from '../../pages/instructorGradebook/instructorGradebook.types.js';

import {
  requireCourseInstancePermissionEdit,
  requireCourseInstancePermissionView,
  t,
} from './init.js';

const sql = loadSqlEquiv(
  new URL('../../pages/instructorGradebook/instructorGradebook.ts', import.meta.url).href,
);

export interface GradebookError {}

const list = t.procedure
  .use(requireCourseInstancePermissionView)
  .output(z.array(GradebookRowSchema))
  .query(async (opts) => {
    const { course, course_instance } = opts.ctx;
    return await queryRows(
      sql.user_scores,
      { course_id: course.id, course_instance_id: course_instance.id },
      GradebookRowSchema,
    );
  });

const editScore = t.procedure
  .use(requireCourseInstancePermissionEdit)
  .input(
    z.object({
      assessmentInstanceId: IdSchema,
      scorePerc: z.number(),
    }),
  )
  .output(z.array(AssessmentInstanceScoreResultSchema))
  .mutation(async (opts) => {
    const { course_instance, authz_data } = opts.ctx;
    const { assessmentInstanceId, scorePerc } = opts.input;

    await checkAssessmentInstanceBelongsToCourseInstance(assessmentInstanceId, course_instance.id);
    await setAssessmentInstanceScore(assessmentInstanceId, scorePerc, authz_data.authn_user.id);

    return await queryRows(
      sql.assessment_instance_score,
      { assessment_instance_id: assessmentInstanceId },
      AssessmentInstanceScoreResultSchema,
    );
  });

export const gradebookRouter = t.router({
  list,
  editScore,
});
