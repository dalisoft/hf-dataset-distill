interface IMessageEntry {
  role: 'user' | 'assistant';
  content: string;
}
interface IMessages {
  messages: IMessageEntry[];
}

interface IBatchResponse {
  id: string;
  archived_at: string;
  cancel_initiated_at: string;
  created_at: string;
  ended_at: string;
  expires_at: string;
  processing_status: 'in_progress' | 'canceling' | 'ended';
  request_counts: {
    canceled: number;
    errored: number;
    expired: number;
    processing: number;
    succeeded: number;
  };
  results_url: string;
  type: 'message_batch';
}
