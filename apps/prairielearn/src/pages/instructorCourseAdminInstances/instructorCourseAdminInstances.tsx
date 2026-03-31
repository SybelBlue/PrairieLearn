import { Router } from 'express';
import fs from 'fs-extra';
import { z } from 'zod';

import * as sqldb from '@prairielearn/postgres';
import { Hydrate } from '@prairielearn/react/server';
import { generatePrefixCsrfToken } from '@prairielearn/signed-token';

import { PageLayout } from '../../components/PageLayout.js';
import { extractPageContext } from '../../lib/client/page-context.js';
import { config } from '../../lib/config.js';
import { CourseInstanceSchema } from '../../lib/db-types.js';
import { idsEqual } from '../../lib/id.js';
import { typedAsyncHandler } from '../../lib/res-locals.js';
import { selectCourseInstancesWithStaffAccess } from '../../models/course-instances.js';

import { InstructorCourseAdminInstances } from './InstructorCourseAdminInstances.html.js';
import { InstructorCourseAdminInstanceRowSchema } from './instructorCourseAdminInstances.shared.js';

const router = Router();
const sql = sqldb.loadSqlEquiv(import.meta.url);

router.get(
  '/',
  typedAsyncHandler<'course'>(async (req, res) => {
    let needToSync = false;
    try {
      await fs.access(res.locals.course.path);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        needToSync = true;
      } else {
        throw new Error('Invalid course path', { cause: err });
      }
    }

    const {
      authz_data: authzData,
      course,
      urlPrefix,
      is_administrator: isAdministrator,
    } = extractPageContext(res.locals, {
      pageType: 'course',
      accessType: 'instructor',
    });

    const trpcUrl = `/pl/course/${course.id}/trpc`;
    const trpcCsrfToken = generatePrefixCsrfToken(
      { url: trpcUrl, authn_user_id: res.locals.authn_user.id },
      config.secretKey,
    );

    const courseInstances = await selectCourseInstancesWithStaffAccess({
      course,
      authzData,
      requiredRole: ['Previewer', 'Student Data Viewer'],
    });

    const enrollmentCounts = await sqldb.queryRows(
      sql.select_enrollment_counts,
      { course_id: course.id },
      z.object({ course_instance_id: CourseInstanceSchema.shape.id, enrollment_count: z.number() }),
    );

    const safeCourseInstancesWithEnrollmentCounts = z
      .array(InstructorCourseAdminInstanceRowSchema)
      .parse(
        courseInstances.map((ci) => ({
          ...ci,
          enrollment_count:
            enrollmentCounts.find((row) => idsEqual(row.course_instance_id, ci.id))
              ?.enrollment_count || 0,
        })),
      );

    res.send(
      PageLayout({
        resLocals: res.locals,
        pageTitle: 'Course Instances',
        navContext: {
          type: 'instructor',
          page: 'course_admin',
          subPage: 'instances',
        },
        options: {
          fullWidth: true,
        },
        content: (
          <Hydrate>
            <InstructorCourseAdminInstances
              courseInstances={safeCourseInstancesWithEnrollmentCounts}
              course={course}
              canEditCourse={authzData.has_course_permission_edit}
              needToSync={needToSync}
              urlPrefix={urlPrefix}
              isAdministrator={isAdministrator}
              trpcCsrfToken={trpcCsrfToken}
              courseId={course.id}
              isDevMode={config.devMode}
            />
          </Hydrate>
        ),
      }),
    );
  }),
);

export default router;
