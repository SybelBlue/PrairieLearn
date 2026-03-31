import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { loadSqlEquiv, queryRows, runInTransactionAsync } from '@prairielearn/postgres';
import { IdSchema } from '@prairielearn/zod';

import type { CourseInstance } from '../../lib/db-types.js';
import {
  addEnrollmentToPublishingExtension,
  createPublishingExtensionWithEnrollments,
  deletePublishingExtension,
  removeStudentFromPublishingExtension,
  selectEnrollmentsForPublishingExtension,
  selectPublishingExtensionById,
  selectPublishingExtensionByName,
  updatePublishingExtension,
} from '../../models/course-instance-publishing-extensions.js';
import { selectUsersAndEnrollmentsByUidsInCourseInstance } from '../../models/enrollment.js';
import { CourseInstancePublishingExtensionRowSchema } from '../../pages/instructorInstanceAdminPublishing/instructorInstanceAdminPublishing.types.js';
import { plainDateTimeStringToDate } from '../../pages/instructorInstanceAdminPublishing/utils/dateUtils.js';

import {
  requireCourseInstancePermissionEdit,
  requireCourseInstancePermissionView,
  requireCoursePermissionEdit,
  t,
} from './init.js';

const sql = loadSqlEquiv(import.meta.url);

export interface PublishingExtensionsError {}

export async function selectPublishingExtensionsWithUsersByCourseInstance({
  courseInstance,
}: {
  courseInstance: CourseInstance;
}) {
  return await queryRows(
    sql.select_publishing_extensions_with_users_by_course_instance,
    { course_instance_id: courseInstance.id },
    CourseInstancePublishingExtensionRowSchema,
  );
}

const list = t.procedure
  .use(requireCourseInstancePermissionView)
  .output(z.array(CourseInstancePublishingExtensionRowSchema))
  .query(async (opts) => {
    return await selectPublishingExtensionsWithUsersByCourseInstance({
      courseInstance: opts.ctx.course_instance,
    });
  });

const checkUids = t.procedure
  .use(requireCourseInstancePermissionEdit)
  .input(z.object({ uids: z.array(z.string()) }))
  .output(z.object({ invalidUids: z.array(z.string()) }))
  .query(async (opts) => {
    const { uids } = opts.input;

    const validRecords = await selectUsersAndEnrollmentsByUidsInCourseInstance({
      uids,
      courseInstance: opts.ctx.course_instance,
      requiredRole: ['Student Data Viewer'],
      authzData: opts.ctx.authz_data,
    });
    const validUids = new Set(validRecords.map((record) => record.user.uid));
    const invalidUids = uids.filter((uid) => !validUids.has(uid));

    return { invalidUids };
  });

const add = t.procedure
  .use(requireCoursePermissionEdit)
  .use(requireCourseInstancePermissionEdit)
  .input(
    z.object({
      name: z
        .string()
        .trim()
        .optional()
        .transform((v) => (v === '' || v === undefined ? null : v)),
      endDate: z.string().trim().min(1),
      uids: z.array(z.string().trim().email()).min(1),
    }),
  )
  .mutation(async (opts) => {
    const { name, endDate, uids } = opts.input;
    const { course_instance: courseInstance, authz_data: authzData } = opts.ctx;

    const enrollments = (
      await selectUsersAndEnrollmentsByUidsInCourseInstance({
        uids,
        courseInstance,
        requiredRole: ['Student Data Viewer'],
        authzData,
      })
    ).map((record) => record.enrollment);

    if (enrollments.length === 0) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'No enrollments found for any of the provided UIDs',
      });
    }

    if (name) {
      const existingExtension = await selectPublishingExtensionByName({
        name,
        courseInstance,
        authzData,
        requiredRole: ['Student Data Viewer'],
      });

      if (existingExtension) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `An extension with the name "${name}" already exists`,
        });
      }
    }

    await createPublishingExtensionWithEnrollments({
      courseInstance,
      name,
      endDate: plainDateTimeStringToDate(endDate, courseInstance.display_timezone),
      enrollments,
      authzData,
      requiredRole: ['Student Data Editor'],
    });
  });

const edit = t.procedure
  .use(requireCoursePermissionEdit)
  .use(requireCourseInstancePermissionEdit)
  .input(
    z.object({
      extensionId: IdSchema,
      name: z
        .string()
        .trim()
        .optional()
        .transform((v) => (v === '' || v === undefined ? null : v)),
      endDate: z.string().trim().optional().default(''),
      uids: z.array(z.string().trim().email()).min(1),
    }),
  )
  .mutation(async (opts) => {
    const { extensionId, name, endDate, uids } = opts.input;
    const { course_instance: courseInstance, authz_data: authzData } = opts.ctx;

    if (name) {
      const existingExtension = await selectPublishingExtensionByName({
        name,
        courseInstance,
        authzData,
        requiredRole: ['Student Data Viewer'],
      });

      if (existingExtension && existingExtension.id !== extensionId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `An extension with the name "${name}" already exists`,
        });
      }
    }

    await runInTransactionAsync(async () => {
      const extension = await selectPublishingExtensionById({
        id: extensionId,
        courseInstance,
        requiredRole: ['Student Data Viewer'],
        authzData,
      });

      const desiredEnrollments = (
        await selectUsersAndEnrollmentsByUidsInCourseInstance({
          uids,
          courseInstance,
          authzData,
          requiredRole: ['Student Data Viewer'],
        })
      ).map((record) => record.enrollment);

      if (desiredEnrollments.length === 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'No enrollments found for provided UIDs',
        });
      }

      await updatePublishingExtension({
        extension,
        name,
        endDate: endDate
          ? plainDateTimeStringToDate(endDate, courseInstance.display_timezone)
          : null,
        authzData,
        requiredRole: ['Student Data Editor'],
      });

      const currentEnrollments = await selectEnrollmentsForPublishingExtension({
        extension,
        authzData,
        requiredRole: ['Student Data Viewer'],
      });
      const desiredEnrollmentsIds = new Set(desiredEnrollments.map((e) => e.id));
      const currentEnrollmentsIds = new Set(currentEnrollments.map((e) => e.id));
      const enrollmentsToAdd = desiredEnrollments.filter((e) => !currentEnrollmentsIds.has(e.id));
      const enrollmentsToRemove = currentEnrollments.filter(
        (e) => !desiredEnrollmentsIds.has(e.id),
      );

      for (const enrollment of enrollmentsToRemove) {
        await removeStudentFromPublishingExtension({
          courseInstancePublishingExtension: extension,
          enrollment,
          authzData,
          requiredRole: ['Student Data Editor'],
        });
      }

      for (const enrollment of enrollmentsToAdd) {
        await addEnrollmentToPublishingExtension({
          courseInstancePublishingExtension: extension,
          enrollment,
          authzData,
          requiredRole: ['Student Data Editor'],
        });
      }
    });
  });

const destroy = t.procedure
  .use(requireCoursePermissionEdit)
  .use(requireCourseInstancePermissionEdit)
  .input(z.object({ extensionId: IdSchema }))
  .mutation(async (opts) => {
    const { extensionId } = opts.input;
    const { course_instance: courseInstance, authz_data: authzData } = opts.ctx;

    const extension = await selectPublishingExtensionById({
      id: extensionId,
      courseInstance,
      requiredRole: ['Student Data Viewer'],
      authzData,
    });

    await deletePublishingExtension({
      extension,
      courseInstance,
      authzData,
      requiredRole: ['Student Data Editor'],
    });
  });

export const publishingExtensionsRouter = t.router({
  list,
  checkUids,
  add,
  edit,
  destroy,
});
