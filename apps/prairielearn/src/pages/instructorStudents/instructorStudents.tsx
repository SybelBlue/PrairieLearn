import * as path from 'path';

import { Router } from 'express';
import asyncHandler from 'express-async-handler';
import z from 'zod';

import { Hydrate } from '@prairielearn/react/server';
import { generatePrefixCsrfToken } from '@prairielearn/signed-token';

import { InsufficientCoursePermissionsCardPage } from '../../components/InsufficientCoursePermissionsCard.js';
import { PageLayout } from '../../components/PageLayout.js';
import { extractPageContext } from '../../lib/client/page-context.js';
import { StaffStudentLabelSchema } from '../../lib/client/safe-db-types.js';
import { getSelfEnrollmentLinkUrl, getStudentCourseInstanceUrl } from '../../lib/client/url.js';
import { config } from '../../lib/config.js';
import { getCourseOwners } from '../../lib/course.js';
import { getOriginalHash } from '../../lib/editors.js';
import { getCanonicalHost, getUrl } from '../../lib/url.js';
import { createAuthzMiddleware } from '../../middlewares/authzHelper.js';
import { selectUsersAndEnrollmentsForCourseInstance } from '../../models/enrollment.js';
import { selectStudentLabelsInCourseInstance } from '../../models/student-label.js';

import { InstructorStudents } from './instructorStudents.html.js';
import { StudentRowSchema } from './instructorStudents.shared.js';

const router = Router();

router.get(
  '/',
  createAuthzMiddleware({
    oneOfPermissions: ['has_course_instance_permission_view'],
    unauthorizedUsers: 'passthrough',
  }),
  asyncHandler(async (req, res) => {
    const pageContext = extractPageContext(res.locals, {
      pageType: 'courseInstance',
      accessType: 'instructor',
    });
    const { authz_data, course_instance: courseInstance, course } = pageContext;

    const search = getUrl(req).search;

    if (!authz_data.has_course_instance_permission_view) {
      const courseOwners = await getCourseOwners(course.id);
      res.status(403).send(
        InsufficientCoursePermissionsCardPage({
          resLocals: res.locals,
          navContext: {
            type: 'instructor',
            page: 'students',
            subPage: 'overview',
          },
          courseOwners,
          pageTitle: 'Students',
          requiredPermissions: 'Student Data Viewer',
        }),
      );
      return;
    }

    const allRows = await selectUsersAndEnrollmentsForCourseInstance(courseInstance);
    const students = allRows.map((r) => StudentRowSchema.parse(r));
    const studentLabels = await selectStudentLabelsInCourseInstance(courseInstance);

    const host = getCanonicalHost(req);
    const selfEnrollLink = new URL(
      courseInstance.self_enrollment_use_enrollment_code
        ? getSelfEnrollmentLinkUrl({
            courseInstanceId: courseInstance.id,
            enrollmentCode: courseInstance.enrollment_code,
          })
        : getStudentCourseInstanceUrl(courseInstance.id),
      host,
    ).href;

    const trpcUrl = `/pl/course_instance/${courseInstance.id}/instructor/trpc`;
    const trpcCsrfToken = generatePrefixCsrfToken(
      { url: trpcUrl, authn_user_id: res.locals.authn_user.id },
      config.secretKey,
    );
    const origHash = await getOriginalHash(
      path.join(
        course.path,
        'courseInstances',
        courseInstance.short_name,
        'infoCourseInstance.json',
      ),
    );

    res.send(
      PageLayout({
        resLocals: res.locals,
        pageTitle: 'Students',
        navContext: {
          type: 'instructor',
          page: 'students',
          subPage: 'overview',
        },
        options: {
          fullWidth: true,
          fullHeight: true,
        },
        content: (
          <Hydrate fullHeight>
            <InstructorStudents
              isDevMode={config.devMode}
              authzData={authz_data}
              students={students}
              studentLabels={z.array(StaffStudentLabelSchema).parse(studentLabels)}
              search={search}
              timezone={course.display_timezone}
              courseInstance={courseInstance}
              course={course}
              selfEnrollLink={selfEnrollLink}
              trpcCsrfToken={trpcCsrfToken}
              origHash={origHash}
            />
          </Hydrate>
        ),
      }),
    );
  }),
);

export default router;
