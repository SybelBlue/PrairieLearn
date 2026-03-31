/* eslint-disable @prairielearn/no-unused-sql-blocks -- assessment_instance_score is used by the gradebook tRPC router */
import { Router } from 'express';
import asyncHandler from 'express-async-handler';
import z from 'zod';

import { loadSqlEquiv, queryRows } from '@prairielearn/postgres';
import { Hydrate } from '@prairielearn/react/server';
import { generatePrefixCsrfToken } from '@prairielearn/signed-token';

import { InsufficientCoursePermissionsCardPage } from '../../components/InsufficientCoursePermissionsCard.js';
import { PageLayout } from '../../components/PageLayout.js';
import { extractPageContext } from '../../lib/client/page-context.js';
import { StaffStudentLabelSchema } from '../../lib/client/safe-db-types.js';
import { config } from '../../lib/config.js';
import { getCourseOwners } from '../../lib/course.js';
import { courseInstanceFilenamePrefix } from '../../lib/sanitize-name.js';
import { getUrl } from '../../lib/url.js';
import { createAuthzMiddleware } from '../../middlewares/authzHelper.js';
import { selectStudentLabelsInCourseInstance } from '../../models/student-label.js';

import { InstructorGradebookTable } from './components/InstructorGradebookTable.js';
import { RoleDescriptionModal } from './components/RoleDescriptionModal.js';
import { CourseAssessmentRowSchema, GradebookRowSchema } from './instructorGradebook.types.js';

const router = Router();
const sql = loadSqlEquiv(import.meta.url);

router.get(
  '/',
  createAuthzMiddleware({
    oneOfPermissions: ['has_course_instance_permission_view'],
    unauthorizedUsers: 'passthrough',
  }),
  asyncHandler(async (req, res) => {
    const { course_instance, course, authz_data, urlPrefix } = extractPageContext(res.locals, {
      pageType: 'courseInstance',
      accessType: 'instructor',
    });

    if (!authz_data.has_course_instance_permission_view) {
      // We don't actually forbid access to this page if the user is not a student
      // data viewer, because we want to allow users to click the gradebook tab and
      // see instructions for how to get student data viewer permissions. Otherwise,
      // users just wouldn't see the tab at all, and this caused a lot of questions
      // about why staff couldn't see the gradebook tab.
      const courseOwners = await getCourseOwners(course.id);
      res.status(403).send(
        InsufficientCoursePermissionsCardPage({
          resLocals: res.locals,
          navContext: {
            type: 'instructor',
            page: 'instance_admin',
            subPage: 'gradebook',
          },
          courseOwners,
          pageTitle: 'Gradebook',
          requiredPermissions: 'Student Data Viewer',
        }),
      );
      return;
    }

    const trpcUrl = `/pl/course_instance/${course_instance.id}/instructor/trpc`;
    const trpcCsrfToken = generatePrefixCsrfToken(
      { url: trpcUrl, authn_user_id: res.locals.authn_user.id },
      config.secretKey,
    );

    const filenameBase = courseInstanceFilenamePrefix(course_instance, course) + 'gradebook';
    const courseAssessments = await queryRows(
      sql.course_assessments,
      { course_instance_id: course_instance.id },
      CourseAssessmentRowSchema,
    );
    const gradebookRows = await queryRows(
      sql.user_scores,
      { course_id: course.id, course_instance_id: course_instance.id },
      GradebookRowSchema,
    );
    const studentLabels = await selectStudentLabelsInCourseInstance(course_instance);

    res.send(
      PageLayout({
        resLocals: res.locals,
        pageTitle: 'Gradebook',
        navContext: {
          type: 'instructor',
          page: 'instance_admin',
          subPage: 'gradebook',
        },
        options: {
          fullWidth: true,
          fullHeight: true,
        },
        content: (
          <Hydrate fullHeight>
            <InstructorGradebookTable
              trpcCsrfToken={trpcCsrfToken}
              courseAssessments={courseAssessments}
              gradebookRows={gradebookRows}
              studentLabels={z.array(StaffStudentLabelSchema).parse(studentLabels)}
              urlPrefix={urlPrefix}
              filenameBase={filenameBase}
              courseInstanceId={course_instance.id}
              search={getUrl(req).search}
              isDevMode={config.devMode}
            />
          </Hydrate>
        ),
        postContent: [RoleDescriptionModal()],
      }),
    );
  }),
);

export default router;
