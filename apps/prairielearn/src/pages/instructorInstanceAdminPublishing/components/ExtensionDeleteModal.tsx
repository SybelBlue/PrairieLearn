import { useMutation } from '@tanstack/react-query';
import { Alert, Modal } from 'react-bootstrap';

import type { createCourseInstanceTrpcClient } from '../../../trpc/courseInstance/client.js';
import { useTRPC } from '../../../trpc/courseInstance/context.js';

export interface ExtensionDeleteModalData {
  extensionId: string;
  extensionName: string | null;
  userData: { uid: string; name: string | null; enrollment_id: string }[];
}

export function ExtensionDeleteModal({
  data,
  trpcClient: _trpcClient,
  show,
  onHide,
  onExited,
  onSuccess,
}: {
  data: ExtensionDeleteModalData | null;
  trpcClient: ReturnType<typeof createCourseInstanceTrpcClient>;
  show: boolean;
  onHide: () => void;
  onExited: () => void;
  onSuccess: () => void;
}) {
  const trpc = useTRPC();
  const deleteMutation = useMutation(
    trpc.publishingExtensions.destroy.mutationOptions({ onSuccess }),
  );

  return (
    <Modal backdrop="static" show={show} onHide={onHide} onExited={onExited}>
      <Modal.Header closeButton>
        <Modal.Title>Delete extension</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {deleteMutation.isError && (
          <Alert variant="danger" dismissible onClose={() => deleteMutation.reset()}>
            {deleteMutation.error.message}
          </Alert>
        )}
        {data && (
          <>
            <p>
              Are you sure you want to delete{' '}
              {data.extensionName === null
                ? 'this extension'
                : `the extension "${data.extensionName}"`}
              ?
            </p>
            <details>
              <summary>Show affected students</summary>
              <table className="table table-bordered table-sm mb-0">
                <thead>
                  <tr>
                    <th>UID</th>
                    <th>Name</th>
                  </tr>
                </thead>
                <tbody>
                  {data.userData.map((user) => (
                    <tr key={user.enrollment_id}>
                      <td>{user.uid}</td>
                      <td>{user.name ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </>
        )}
      </Modal.Body>
      <Modal.Footer>
        <button
          type="button"
          className="btn btn-outline-secondary"
          disabled={deleteMutation.isPending}
          onClick={onHide}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={deleteMutation.isPending}
          onClick={() => {
            if (!data) return;
            deleteMutation.mutate({ extensionId: data.extensionId });
          }}
        >
          {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
        </button>
      </Modal.Footer>
    </Modal>
  );
}
