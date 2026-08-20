import { ComparePage } from './components/page/ComparePage';
import { ToastContainer } from './components/Toast';

export default function App() {
  return (
    <div className="h-screen overflow-hidden flex flex-col">
      <ComparePage />
      <ToastContainer />
    </div>
  );
}
