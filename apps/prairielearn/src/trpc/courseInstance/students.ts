import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { callScalar } from '@prairielearn/postgres';

import type { AuthzDataWithEffectiveUser } from '../../lib/authz-data-lib.js';
import { StaffEnrollmentSchema } from '../../lib/client/safe-db-types.js';
import type { CourseInstance } from '../../lib/db-types.js';
import { type ServerJobLogger, createServerJob } from '../../lib/server-jobs.js';
import {
  deleteEnrollment,
  inviteStudentByUid,
  reenrollEnrollmentFromSync,
  removeEnrollmentFromSync,
  selectOptionalEnrollmentByUid,
  selectUsersAndEnrollmentsForCourseInstance,
} from '../../models/enrollment.js';
import { selectOptionalUserByUid } from '../../models/user.js';
import { StudentRowSchema } from '../../pages/instructorStudents/instructorStudents.shared.js';

import {
  requireCourseInstancePermissionEdit,
  requireCourseInstancePermissionView,
  t,
} from './init.js';

export interface StudentsError {}

interface InviteCounts {
  invited: number;
  unblocked: number;
  reenrolled: number;
  skippedLti13Pending: number;
  skippedInstructor: number;
  skippedAlreadyInvited: number;
  skippedAlreadyJoined: number;
  skippedAlreadyBlocked: number;
  skippedAlreadyRemoved: number;
  errors: number;
}

async function processInvitations({
  uids,
  courseInstance,
  authzData,
  job,
  counts,
  skipBlocked,
  allowReenroll,
  actionDetail = 'invited',
}: {
  uids: string[];
  courseInstance: CourseInstance;
  authzData: AuthzDataWithEffectiveUser;
  job: ServerJobLogger;
  counts: InviteCounts;
  skipBlocked: boolean;
  allowReenroll: boolean;
  actionDetail?: 'invited' | 'invited_by_manual_sync';
}): Promise<void> {
  for (const uid of uids) {
    try {
      const user = await selectOptionalUserByUid(uid);
      if (user) {
        const isInstructor = await callScalar(
          'users_is_instructor_in_course_instance',
          [user.id, courseInstance.id],
          z.boolean(),
        );
        if (isInstructor) {
          job.info(`${uid}: Skipped (instructor)`);
          counts.skippedInstructor++;
          continue;
        }
      }

      const existingEnrollment = await selectOptionalEnrollmentByUid({
        courseInstance,
        uid,
        requiredRole: ['Student Data Viewer'],
        authzData,
      });

      if (existingEnrollment?.status === 'joined') {
        job.info(`${uid}: Skipped (already enrolled)`);
        counts.skippedAlreadyJoined++;
        continue;
      }
      if (existingEnrollment?.status === 'invited') {
        job.info(`${uid}: Skipped (already invited)`);
        counts.skippedAlreadyInvited++;
        continue;
      }
      if (existingEnrollment?.status === 'lti13_pending') {
        job.info(`${uid}: Skipped (LTI-managed enrollment)`);
        counts.skippedLti13Pending++;
        continue;
      }
      if (skipBlocked && existingEnrollment?.status === 'blocked') {
        job.info(`${uid}: Skipped (blocked)`);
        counts.skippedAlreadyBlocked++;
        continue;
      }
      if (!allowReenroll && existingEnrollment?.status === 'removed') {
        job.info(`${uid}: Skipped (removed)`);
        counts.skippedAlreadyRemoved++;
        continue;
      }

      if (allowReenroll && existingEnrollment?.status === 'blocked') {
        await reenrollEnrollmentFromSync({
          enrollment: existingEnrollment,
          authzData,
          requiredRole: ['Student Data Editor'],
        });
        job.info(`${uid}: Unblocked`);
        counts.unblocked++;
        continue;
      }

      if (allowReenroll && existingEnrollment?.status === 'removed') {
        await reenrollEnrollmentFromSync({
          enrollment: existingEnrollment,
          authzData,
          requiredRole: ['Student Data Editor'],
        });
        job.info(`${uid}: Reenrolled`);
        counts.reenrolled++;
        continue;
      }

      await inviteStudentByUid({
        courseInstance,
        uid,
        requiredRole: ['Student Data Editor'],
        authzData,
        actionDetail,
      });
      job.info(`${uid}: Invited`);
      counts.invited++;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      job.error(`${uid}: Error - ${message}`);
      counts.errors++;
    }
  }
}

const list = t.procedure.use(requireCourseInstancePermissionView).query(async (opts) => {
  const rows = await selectUsersAndEnrollmentsForCourseInstance(opts.ctx.course_instance);
  return rows.map((r) => StudentRowSchema.parse(r));
});

const getEnrollment = t.procedure
  .use(requireCourseInstancePermissionView)
  .input(z.object({ uid: z.string() }))
  .output(StaffEnrollmentSchema.nullable())
  .query(async (opts) => {
    const enrollment = await selectOptionalEnrollmentByUid({
      courseInstance: opts.ctx.course_instance,
      uid: opts.input.uid,
      requiredRole: ['Student Data Viewer'],
      authzData: opts.ctx.authz_data,
    });
    return StaffEnrollmentSchema.nullable().parse(enrollment);
  });

const inviteStudents = t.procedure
  .use(requireCourseInstancePermissionEdit)
  .input(z.object({ uids: z.array(z.string()).min(1).max(1000) }))
  .output(z.object({ jobSequenceId: z.string() }))
  .mutation(async (opts) => {
    const { course_instance: courseInstance, course, authz_data: authzData } = opts.ctx;

    if (!courseInstance.modern_publishing) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Modern publishing is not enabled for this course instance',
      });
    }

    const serverJob = await createServerJob({
      type: 'invite_students',
      description: 'Invite students to course instance',
      userId: authzData.user.id,
      authnUserId: authzData.authn_user.id,
      courseId: course.id,
      courseInstanceId: courseInstance.id,
    });

    serverJob.executeInBackground(async (job) => {
      const counts: InviteCounts = {
        invited: 0,
        unblocked: 0,
        reenrolled: 0,
        skippedLti13Pending: 0,
        skippedInstructor: 0,
        skippedAlreadyInvited: 0,
        skippedAlreadyJoined: 0,
        skippedAlreadyBlocked: 0,
        skippedAlreadyRemoved: 0,
        errors: 0,
      };

      await processInvitations({
        uids: opts.input.uids,
        courseInstance,
        authzData,
        job,
        counts,
        skipBlocked: true,
        allowReenroll: false,
      });

      job.info('\nSummary:');
      job.info(`  Successfully invited: ${counts.invited}`);
      const summaryLines: [number, string][] = [
        [counts.skippedAlreadyJoined, 'Skipped (already enrolled)'],
        [counts.skippedAlreadyInvited, 'Skipped (already invited)'],
        [counts.skippedAlreadyBlocked, 'Skipped (blocked)'],
        [counts.skippedAlreadyRemoved, 'Skipped (removed)'],
        [counts.skippedLti13Pending, 'Skipped (LTI-managed)'],
        [counts.skippedInstructor, 'Skipped (instructor)'],
        [counts.errors, 'Errors'],
      ];
      for (const [count, label] of summaryLines) {
        if (count > 0) {
          job.info(`  ${label}: ${count}`);
        }
      }
    });

    return { jobSequenceId: serverJob.jobSequenceId };
  });

const syncStudents = t.procedure
  .use(requireCourseInstancePermissionEdit)
  .input(
    z.object({
      toInvite: z.array(z.string().email()).max(5000),
      toCancelInvitation: z.array(z.string().email()).max(5000),
      toRemove: z.array(z.string().email()).max(5000),
    }),
  )
  .output(z.object({ jobSequenceId: z.string() }))
  .mutation(async (opts) => {
    const { course_instance: courseInstance, course, authz_data: authzData } = opts.ctx;

    if (!courseInstance.modern_publishing) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Modern publishing is not enabled for this course instance',
      });
    }

    const { toInvite, toCancelInvitation, toRemove } = opts.input;

    const serverJob = await createServerJob({
      type: 'sync_students',
      description: 'Synchronize student list',
      userId: authzData.user.id,
      authnUserId: authzData.authn_user.id,
      courseId: course.id,
      courseInstanceId: courseInstance.id,
    });

    serverJob.executeInBackground(async (job) => {
      const syncCounts: InviteCounts = {
        invited: 0,
        unblocked: 0,
        reenrolled: 0,
        skippedLti13Pending: 0,
        skippedInstructor: 0,
        skippedAlreadyInvited: 0,
        skippedAlreadyJoined: 0,
        skippedAlreadyBlocked: 0,
        skippedAlreadyRemoved: 0,
        errors: 0,
      };
      let cancelled = 0;
      let cancelErrors = 0;
      let removed = 0;
      let removeErrors = 0;

      if (toInvite.length > 0) {
        job.info('Processing invitations...');
        await processInvitations({
          uids: toInvite,
          courseInstance,
          authzData,
          job,
          counts: syncCounts,
          skipBlocked: false,
          allowReenroll: true,
          actionDetail: 'invited_by_manual_sync',
        });
      }

      if (toCancelInvitation.length > 0) {
        job.info('\nCancelling invitations...');
        for (const uid of toCancelInvitation) {
          try {
            const enrollment = await selectOptionalEnrollmentByUid({
              courseInstance,
              uid,
              requiredRole: ['Student Data Viewer'],
              authzData,
            });

            if (!enrollment) {
              job.info(`${uid}: Skipped (no enrollment found)`);
              continue;
            }
            if (!['invited', 'rejected'].includes(enrollment.status)) {
              job.info(`${uid}: Skipped (not an invitation)`);
              continue;
            }

            await deleteEnrollment({
              enrollment,
              actionDetail: 'invitation_deleted_by_manual_sync',
              authzData,
              requiredRole: ['Student Data Editor'],
            });
            job.info(`${uid}: Invitation cancelled`);
            cancelled++;
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            job.error(`${uid}: Error - ${message}`);
            cancelErrors++;
          }
        }
      }

      if (toRemove.length > 0) {
        job.info('\nProcessing removals...');
        for (const uid of toRemove) {
          try {
            const enrollment = await selectOptionalEnrollmentByUid({
              courseInstance,
              uid,
              requiredRole: ['Student Data Viewer'],
              authzData,
            });

            if (!enrollment) {
              job.info(`${uid}: Skipped (no enrollment found)`);
              continue;
            }
            if (enrollment.status === 'removed') {
              job.info(`${uid}: Skipped (already removed)`);
              continue;
            }

            await removeEnrollmentFromSync({
              enrollment,
              authzData,
              requiredRole: ['Student Data Editor'],
            });
            job.info(`${uid}: Removed`);
            removed++;
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            job.error(`${uid}: Error - ${message}`);
            removeErrors++;
          }
        }
      }

      job.info('\nSummary:');
      job.info(`  Invited: ${syncCounts.invited}`);
      job.info(`  Invitations cancelled: ${cancelled}`);
      job.info(`  Removed: ${removed}`);
      const totalErrors = syncCounts.errors + cancelErrors + removeErrors;
      const syncSummaryLines: [number, string][] = [
        [syncCounts.unblocked, 'Unblocked'],
        [syncCounts.reenrolled, 'Reenrolled'],
        [syncCounts.skippedAlreadyJoined, 'Skipped (already joined)'],
        [syncCounts.skippedAlreadyInvited, 'Skipped (already invited)'],
        [syncCounts.skippedLti13Pending, 'Skipped (LTI-managed)'],
        [syncCounts.skippedInstructor, 'Skipped (instructor)'],
        [totalErrors, 'Errors'],
      ];
      for (const [count, label] of syncSummaryLines) {
        if (count > 0) {
          job.info(`  ${label}: ${count}`);
        }
      }
    });

    return { jobSequenceId: serverJob.jobSequenceId };
  });

export const studentsRouter = t.router({
  list,
  getEnrollment,
  inviteStudents,
  syncStudents,
});
