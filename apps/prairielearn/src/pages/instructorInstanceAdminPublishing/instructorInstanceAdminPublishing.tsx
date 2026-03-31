import assert from 'assert';
import * as path from 'path';

import { Router } from 'express';
import fs from 'fs-extra';
import z from 'zod';

import * as error from '@prairielearn/error';
import { flash } from '@prairielearn/flash';
import { loadSqlEquiv, queryRows } from '@prairielearn/postgres';
import { Hydrate } from '@prairielearn/react/server';
import { generatePrefixCsrfToken } from '@prairielearn/signed-token';
import { DatetimeLocalStringSchema } from '@prairielearn/zod';

import { PageLayout } from '../../components/PageLayout.js';
import { b64EncodeUnicode } from '../../lib/base64-util.js';
import { extractPageContext } from '../../lib/client/page-context.js';
import { isRenderableComment } from '../../lib/comments.js';
import { config } from '../../lib/config.js';
import { CourseInstanceAccessRuleSchema } from '../../lib/db-types.js';
import { propertyValueWithDefault } from '../../lib/editorUtil.shared.js';
import { FileModifyEditor, getOriginalHash } from '../../lib/editors.js';
import { getPaths } from '../../lib/instructorFiles.js';
import { formatJsonWithPrettier } from '../../lib/prettier.js';
import { typedAsyncHandler } from '../../lib/res-locals.js';
import { createAuthzMiddleware } from '../../middlewares/authzHelper.js';
import { type CourseInstanceJsonInput } from '../../schemas/infoCourseInstance.js';
import { selectPublishingExtensionsWithUsersByCourseInstance } from '../../trpc/courseInstance/publishing-extensions.js';

import { CourseInstancePublishing } from './components/CourseInstancePublishing.js';
import { LegacyAccessRuleCard } from './components/LegacyAccessRuleCard.js';

const router = Router();
const sql = loadSqlEquiv(import.meta.url);

router.get(
  '/',
  createAuthzMiddleware({
    oneOfPermissions: ['has_course_permission_view', 'has_course_instance_permission_view'],
    unauthorizedUsers: 'block',
  }),
  typedAsyncHandler<'course-instance'>(async (req, res) => {
    const {
      authz_data: authzData,
      __csrf_token: csrfToken,
      course_instance: courseInstance,
      course,
    } = extractPageContext(res.locals, {
      pageType: 'courseInstance',
      accessType: 'instructor',
    });

    const {
      has_course_permission_edit: hasCoursePermissionEdit,
      has_course_instance_permission_edit: hasCourseInstancePermissionEdit,
      has_course_instance_permission_view: hasCourseInstancePermissionView,
    } = authzData;

    assert(hasCourseInstancePermissionEdit !== undefined);
    assert(hasCourseInstancePermissionView !== undefined);

    // Only fetch extensions if user has student data view permission
    const publishingExtensions = hasCourseInstancePermissionView
      ? await selectPublishingExtensionsWithUsersByCourseInstance({
          courseInstance,
        })
      : [];

    const trpcUrl = `/pl/course_instance/${courseInstance.id}/instructor/trpc`;
    const trpcCsrfToken = generatePrefixCsrfToken(
      { url: trpcUrl, authn_user_id: res.locals.authn_user.id },
      config.secretKey,
    );

    // Calculate orig_hash for the infoCourseInstance.json file
    const infoCourseInstancePath = path.join(
      course.path,
      'courseInstances',
      courseInstance.short_name,
      'infoCourseInstance.json',
    );
    const origHash = await getOriginalHash(infoCourseInstancePath);

    const accessRules = await queryRows(
      sql.course_instance_access_rules,
      { course_instance_id: courseInstance.id },
      CourseInstanceAccessRuleSchema,
    );

    const showComments = accessRules.some((access_rule) =>
      isRenderableComment(access_rule.json_comment),
    );

    res.send(
      PageLayout({
        resLocals: res.locals,
        pageTitle: 'Publishing',
        navContext: {
          type: 'instructor',
          page: 'instance_admin',
          subPage: 'publishing',
        },
        content: courseInstance.modern_publishing ? (
          <Hydrate>
            <CourseInstancePublishing
              courseInstance={courseInstance}
              canEditPublishing={
                hasCoursePermissionEdit && !course.example_course && origHash !== null
              }
              canViewExtensions={hasCourseInstancePermissionView}
              canEditExtensions={hasCoursePermissionEdit && hasCourseInstancePermissionEdit}
              csrfToken={csrfToken}
              trpcCsrfToken={trpcCsrfToken}
              courseInstanceId={courseInstance.id}
              origHash={origHash}
              extensions={publishingExtensions}
              isDevMode={config.devMode}
            />
          </Hydrate>
        ) : (
          <LegacyAccessRuleCard
            accessRules={accessRules}
            showComments={showComments}
            courseInstance={courseInstance}
            hasCourseInstancePermissionView={hasCourseInstancePermissionView}
          />
        ),
      }),
    );
  }),
);

router.post(
  '/',
  typedAsyncHandler<'course-instance'>(async (req, res) => {
    const {
      authz_data: authzData,
      course,
      course_instance: courseInstance,
      urlPrefix,
    } = extractPageContext(res.locals, {
      pageType: 'courseInstance',
      accessType: 'instructor',
    });

    const { has_course_permission_edit: hasCoursePermissionEdit } = authzData;

    if (req.body.__action === 'update_publishing') {
      if (!hasCoursePermissionEdit) {
        throw new error.HttpStatusError(403, 'Access denied (must be a course editor)');
      }
      if (!courseInstance.modern_publishing) {
        flash('error', 'Cannot update publishing when legacy allowAccess rules are present');
        res.redirect(req.originalUrl);
        return;
      }
      // Read the existing infoCourseInstance.json file
      const infoCourseInstancePath = path.join(
        course.path,
        'courseInstances',
        courseInstance.short_name,
        'infoCourseInstance.json',
      );

      if (!(await fs.pathExists(infoCourseInstancePath))) {
        flash('error', 'infoCourseInstance.json does not exist');
        res.redirect(req.originalUrl);
        return;
      }

      const courseInstanceInfo: CourseInstanceJsonInput = JSON.parse(
        await fs.readFile(infoCourseInstancePath, 'utf8'),
      );

      const parsedBody = z
        .object({
          start_date: z.union([z.literal(''), DatetimeLocalStringSchema]),
          end_date: z.union([z.literal(''), DatetimeLocalStringSchema]),
        })
        .parse(req.body);

      // Update the publishing settings
      const resolvedPublishing = {
        startDate: propertyValueWithDefault(
          courseInstanceInfo.publishing?.startDate,
          parsedBody.start_date,
          (v: string) => v === '',
        ),
        endDate: propertyValueWithDefault(
          courseInstanceInfo.publishing?.endDate,
          parsedBody.end_date,
          (v: string) => v === '',
        ),
      };
      const hasPublishing = Object.values(resolvedPublishing).some((v) => v !== undefined);
      if (!hasPublishing) {
        courseInstanceInfo.publishing = undefined;
      } else {
        courseInstanceInfo.publishing = resolvedPublishing;
      }

      // Format and write the updated JSON
      const formattedJson = await formatJsonWithPrettier(JSON.stringify(courseInstanceInfo));

      // JSON file has been formatted and is ready to be written
      const paths = getPaths(undefined, res.locals);
      const editor = new FileModifyEditor({
        locals: res.locals,
        container: {
          rootPath: paths.rootPath,
          invalidRootPaths: paths.invalidRootPaths,
        },
        filePath: infoCourseInstancePath,
        editContents: b64EncodeUnicode(formattedJson),
        origHash: req.body.orig_hash,
      });

      const serverJob = await editor.prepareServerJob();
      try {
        await editor.executeWithServerJob(serverJob);
      } catch {
        res.redirect(urlPrefix + '/edit_error/' + serverJob.jobSequenceId);
        return;
      }

      flash('success', 'Publishing settings updated successfully');
      res.redirect(req.originalUrl);
      return;
    }

    throw new error.HttpStatusError(400, `unknown __action: ${req.body.__action}`);
  }),
);

export default router;
