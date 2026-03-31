import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';

import * as error from '@prairielearn/error';
import * as sqldb from '@prairielearn/postgres';

import { EnumCourseInstanceRoleSchema } from '../../lib/db-types.js';
import { propertyValueWithDefault } from '../../lib/editorUtil.shared.js';
import { CourseInstanceAddEditor } from '../../lib/editors.js';
import { validateShortName } from '../../lib/short-name.js';
import { selectCourseInstanceByUuid } from '../../models/course-instances.js';
import { insertCourseInstancePermissions } from '../../models/course-permissions.js';
import { throwAppError } from '../app-errors.js';

import { requireCoursePermissionEdit, t } from './init.js';

const sql = sqldb.loadSqlEquiv(import.meta.url);

export interface CourseInstancesError {
  Create: { code: 'EDITOR_FAILED'; jobSequenceId: string };
}

const create = t.procedure
  .use(requireCoursePermissionEdit)
  .input(
    z.object({
      short_name: z.string().trim(),
      long_name: z.string().trim(),
      start_date: z.string(),
      end_date: z.string(),
      self_enrollment_enabled: z.boolean().optional(),
      self_enrollment_use_enrollment_code: z.boolean().optional(),
      course_instance_permission: EnumCourseInstanceRoleSchema.optional().default('None'),
    }),
  )
  .mutation(async (opts) => {
    const { course, authz_data, locals } = opts.ctx;
    const {
      short_name,
      long_name,
      start_date,
      end_date,
      self_enrollment_enabled,
      self_enrollment_use_enrollment_code,
      course_instance_permission,
    } = opts.input;

    if (!short_name) {
      throw new error.HttpStatusError(400, 'Short name is required');
    }

    if (!long_name) {
      throw new error.HttpStatusError(400, 'Long name is required');
    }

    const shortNameValidation = validateShortName(short_name);
    if (!shortNameValidation.valid) {
      throw new error.HttpStatusError(
        400,
        `Invalid short name: ${shortNameValidation.lowercaseMessage}`,
      );
    }

    const existingNames = await sqldb.queryRows(
      sql.select_names,
      { course_id: course.id },
      z.object({ short_name: z.string(), long_name: z.string().nullable() }),
    );
    const existingShortNames = existingNames.map((name) => name.short_name.toLowerCase());
    const existingLongNames = existingNames
      .map((name) => name.long_name?.toLowerCase())
      .filter((name) => name != null);

    if (existingShortNames.includes(short_name.toLowerCase())) {
      throw new error.HttpStatusError(400, 'A course instance with this short name already exists');
    }

    if (existingLongNames.includes(long_name.toLowerCase())) {
      throw new error.HttpStatusError(400, 'A course instance with this long name already exists');
    }

    const startDate = start_date.length > 0 ? start_date : undefined;
    const endDate = end_date.length > 0 ? end_date : undefined;

    if (startDate && endDate) {
      const startAccessDate = Temporal.PlainDateTime.from(startDate).toZonedDateTime(
        course.display_timezone,
      );
      const endAccessDate = Temporal.PlainDateTime.from(endDate).toZonedDateTime(
        course.display_timezone,
      );
      if (startAccessDate.epochMilliseconds >= endAccessDate.epochMilliseconds) {
        throw new error.HttpStatusError(400, 'End date must be after start date');
      }
    }

    const resolvedPublishing =
      (startDate ?? endDate)
        ? {
            startDate,
            endDate,
          }
        : undefined;

    const selfEnrollmentEnabled = propertyValueWithDefault(
      undefined,
      self_enrollment_enabled,
      true,
    );
    const selfEnrollmentUseEnrollmentCode = propertyValueWithDefault(
      undefined,
      self_enrollment_use_enrollment_code,
      false,
    );

    const resolvedSelfEnrollment =
      (selfEnrollmentEnabled ?? selfEnrollmentUseEnrollmentCode) !== undefined
        ? {
            enabled: selfEnrollmentEnabled,
            useEnrollmentCode: selfEnrollmentUseEnrollmentCode,
          }
        : undefined;

    const editor = new CourseInstanceAddEditor({
      locals,
      short_name,
      long_name,
      metadataOverrides: {
        publishing: resolvedPublishing,
        selfEnrollment: resolvedSelfEnrollment,
      },
    });

    const serverJob = await editor.prepareServerJob();
    try {
      await editor.executeWithServerJob(serverJob);
    } catch {
      throwAppError<CourseInstancesError['Create']>({
        code: 'EDITOR_FAILED',
        jobSequenceId: serverJob.jobSequenceId,
      });
    }

    const courseInstance = await selectCourseInstanceByUuid({
      uuid: editor.uuid,
      course,
    });

    if (course_instance_permission !== 'None') {
      await insertCourseInstancePermissions({
        course_id: course.id,
        course_instance_id: courseInstance.id,
        user_id: authz_data.authn_user.id,
        course_instance_role: course_instance_permission,
        authn_user_id: authz_data.authn_user.id,
      });
    }

    return { courseInstanceId: courseInstance.id };
  });

export const courseInstancesRouter = t.router({
  create,
});
