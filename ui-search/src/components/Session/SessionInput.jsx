import {
  Button,
  Container,
  Grid,
  Input,
  ProgressBar,
  StatusIndicator,
} from '@cloudscape-design/components';
import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useParams } from 'react-router-dom';
import useInput from 'src/hooks/useInput';
import useLsAppConfigs from 'src/hooks/useLsAppConfigs';
import useLsSessionList from 'src/hooks/useLsSessionList';
import AutoScrollToDiv from '../AutoScrollToDiv';
import { StyledBoxVerticalCenter } from '../StyledComponents';
import ChatIcon from './ChatIcon';

const GENERAL_WSS_ERROR_MSG = 'Error on receiving message from Websocket';
let firstStream = true;

const SessionInput = ({ data }) => {
  const [query, bindQuery, resetQuery] = useInput();
  const [loading, setLoading] = useState(false);
  const [percentage, setPercentage] = useState(0);
  const { sessionId } = useParams();

  // NOTE: to automatically scroll down to the user input
  useEffect(() => {
    return () => {
      resetQuery();
    };
  }, [data, resetQuery]);

  // NOTE: fake loading mechanism after user send query
  useEffect(() => {
    let interval;
    if (loading) {
      interval = setInterval(() => {
        setPercentage((prev) => {
          if (prev > 98) {
            clearInterval(interval);
            return prev;
          }
          return prev + 1;
        });
      }, 150);
    } else {
      setPercentage(0);
    }
    return () => clearInterval(interval);
  }, [loading]);

  const { urlWss, urlApiGateway } = useLsAppConfigs();
  const socket = useRef(null);
  const [isConnected, setIsConnected] = useState(false);
  const {
    lsSessionList,
    lsGetCurSessionConfig,
    lsAddContentToSessionItem,
    lsUpdateContentOfLastConvoInOneSessionItem,
  } = useLsSessionList();

  // NOTE: what to do when websocket connection is established
  const onSocketOpen = useCallback(() => {
    setIsConnected(true);
    // socket.current?.send(
    //   JSON.stringify({ action: 'createSession', sessionData })
    // );
  }, []);

  // NOTE: what to do when websocket connection is closed
  const onSocketClose = useCallback(() => {
    setIsConnected(false);
  }, []);

  // NOTE: what to do when web receives a message from websocket connection
  const onSocketMessage = useCallback(
    (dataStr) => {
      try {
        const data = JSON.parse(dataStr);
        // console.log({ data });
        // TODO?: to add a parsing mechanism?
        switch (data.message) {
          case 'streaming':
            // do this when streaming text/answer
            onStreaming(data, firstStream);
            firstStream = false;
            return;
          case 'streaming_end':
            // do this when streaming ends
            onStreaming(data);
            setLoading(false);
            firstStream = true;
            resetQuery();
            return;
          case 'success':
            onSuccess(data);
            return;
          case 'error':
            // do something when errors occur
            toast.error(data.errorMessage || GENERAL_WSS_ERROR_MSG);
            setLoading(false);
            return;
          case 'others':
            // future expansion
            setLoading(false);
            return;
          default:
            // same as 'success' with warning toast
            onSuccess(data);
            toast('WARNING: WSS message is not following the standard', {
              icon: '⚠️',
            });
            return;
        }
      } catch (error) {
        toast.error(error?.message || GENERAL_WSS_ERROR_MSG);
      }
      function onSuccess(data) {
        lsAddContentToSessionItem(sessionId, lsSessionList, {
          type: 'robot',
          content: data,
        });
        setLoading(false);
        resetQuery();
      }
      function onStreaming(data, firstStream) {
        lsUpdateContentOfLastConvoInOneSessionItem(
          sessionId,
          lsSessionList,
          data,
          firstStream
        );
      }
    },
    // NOTE temp solution for unnecessary re-rendering on lsSessionList change
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lsAddContentToSessionItem, sessionId, lsSessionList.length]
  );

  // TODO: optimize connection id generation logic
  const privateConnectionId = useCallback(() => `private-${Date.now()}`, [urlWss])

  const initSocket = useCallback(() => {
    try {
      console.log('init WSS');
      if (!urlWss) throw new Error('urlWss is not defined');

      if (socket.current?.readyState !== WebSocket.OPEN) {
        socket.current = new WebSocket(urlWss, urlWss.includes('appsync') ? ['graphql-ws'] : undefined);
        socket.current.addEventListener('open', onSocketOpen);
        socket.current.addEventListener('close', onSocketClose);


        if (urlWss.includes('appsync')) {
          // appsync specific activities
          const header = JSON.parse(atob(new URL(urlWss).searchParams.get('header'))) // TODO: avoid the legacy atob
          socket.current.addEventListener('open', () => {
            socket.current.send(JSON.stringify({ type: 'connection_init' }))
          })
          socket.current.addEventListener('message', (event) => {
            const e = JSON.parse(event);
            if (e.type === 'connection_ack') {
                socket.current.send(JSON.stringify({
                  "type": "start",
                  "id": `${Date.now()}`, // TODO: better id design, prefer UUID
                  "payload": {
                    "data": JSON.stringify({
                      query: "subscription SubscribeToData($name: String!) { subscribe(name: $name) { name data } }",
                      variables: {
                        name: privateConnectionId(),
                      }
                    }),
                    "extensions":{
                      "authorization": {
                        "x-api-key": header['x-api-key'],
                        "host": header['host']
                      }
                    }
                  },
                }))
            }
            if (e.type === 'data') {
              onSocketMessage(e.payload.data.subscribe.data)
            }
          })
        } else {
          // api gateway websocket message
          socket.current.addEventListener('message', (event) =>
            onSocketMessage(event.data)
          );
        }
      }
      return true;
    } catch (error) {
      console.error(error);
      setIsConnected(false);
      return false;
    }
  }, [urlWss, onSocketOpen, onSocketClose, onSocketMessage]);

  useEffect(() => {
    // create websocket connection
    if (socket.current?.readyState !== WebSocket.OPEN) {
      initSocket();
    }
    return () => {
      console.log('WSS closed');
      socket.current?.close();
      setIsConnected(false);
    };
  }, [initSocket]);

  // NOTE: send query through websocket connection
  const socketSendSearch = useCallback(() => {
    if (socket.current?.readyState !== WebSocket.OPEN) {
      const success = initSocket();
      if (!success)
        throw new Error('Socket connection can not be established...');
    }
    const configs = lsGetCurSessionConfig(sessionId, lsSessionList);
    if (!configs) throw new Error('No session config found');
    lsAddContentToSessionItem(sessionId, lsSessionList, {
      type: 'customer',
      content: { text: query, timestamp: Date.now() },
    });
    if (urlWss.includes('appsync')) {
      fetch(`${urlApiGateway}/private_search`, {
        method: 'POST',
        body: JSON.stringify({ action: 'search', configs, query }),
        headers: {
          connectionId: privateConnectionId()
        }
      })
    } else {
      socket.current?.send(JSON.stringify({ action: 'search', configs, query }));
    }
  }, [
    urlWss,
    urlApiGateway,
    privateConnectionId,
    lsGetCurSessionConfig,
    sessionId,
    query,
    initSocket,
    lsSessionList,
    lsAddContentToSessionItem,
  ]);

  // const onDisconnect = useCallback(() => {
  //   if (isConnected) socket.current?.close();
  // }, [isConnected]);

  const handleOnEnterSearch = useCallback(async () => {
    if (!query) {
      return toast('Please enter a query to search', { icon: '⚠️' });
    }
    // console.log({ query });
    setLoading(true);
    socketSendSearch();
  }, [query, socketSendSearch]);

  return (
    <Container>
      <AutoScrollToDiv data={data} />
      <Grid
        gridDefinition={[
          { colspan: 0.5 },
          { colspan: 9 },
          { colspan: 1.5 },
          { colspan: 1 },
        ]}
      >
        <ChatIcon />
        <StyledBoxVerticalCenter>
          {loading ? (
            <ProgressBar
              variant="key-value"
              // label="Status"
              value={percentage}
              // description="Searching"
            />
          ) : (
            <Input
              disabled={!isConnected}
              autoFocus
              {...bindQuery}
              // onKeyUp={(e) =>
              //   e.detail.key === 'Enter' ? handleOnEnterSearch() : null
              // }
              data-corner-style="rounded"
              placeholder="Search Input"
            />
          )}
        </StyledBoxVerticalCenter>
        <StyledBoxVerticalCenter>
          <Button
            variant="primary"
            disabled={!isConnected}
            loading={loading}
            onClick={handleOnEnterSearch}
          >
            Search
          </Button>
        </StyledBoxVerticalCenter>
        <StyledBoxVerticalCenter>
          <StatusIndicator type={isConnected ? 'success' : 'stopped'}>
            WSS
          </StatusIndicator>
        </StyledBoxVerticalCenter>
      </Grid>
    </Container>
  );
};

export default SessionInput;

const content = {
  text: 'Testing Adding an ai response. Exercitation nulla tempor velit exercitation dolore ea in exercitation. Labore eu labore nisi nisi ipsum consequat ad. Incididunt qui ex dolor reprehenderit velit eiusmod ullamco et.',
  timestamp: '1793884718573',
  scoreQueryAnswer: 0.902,
  contentCheckLabel: 'terror',
  contentCheckSuggestion: 'block',
  sourceData: [
    {
      id: 'abc',
      title:
        'Exercitation voluptate enim officia proident elit et laborum quis.',
      scoreQueryDoc: 0.402,
      scoreAnswerDoc: 0.302,
      titleLink: 'http://#',
      paragraph:
        'Deserunt fugiat proident officia ut non reprehenderit velit veniam laborum. Ad sit laboris pariatur nulla tempor Lorem adipisicing. Cupidatat non cupidatat ex ullamco aute. Et culpa anim id deserunt',
    },
    {
      id: 'abcd',
      title: 'Exercitation qui ipsum laborum amet sunt magna laborum aliquip.',
      scoreQueryDoc: 0.402,
      scoreAnswerDoc: 0.302,
      paragraph:
        'Deserunt fugiat proident officia ut non reprehenderit velit veniam laborum. Ad sit laboris pariatur nulla tempor Lorem adipisicing. Cupidatat non cupidatat ex ullamco aute. Et culpa anim id deserunt',
    },
    {
      id: 'abcde',
      title:
        'Ut cupidatat laborum adipisicing ad irure ut deserunt elit veniam id Lorem.',
      scoreQueryDoc: 0.402,
      scoreAnswerDoc: 0.302,
      paragraph:
        'Deserunt fugiat proident officia ut non reprehenderit velit veniam laborum. Ad sit laboris pariatur nulla tempor Lorem adipisicing. Cupidatat non cupidatat ex ullamco aute. Et culpa anim id deserunt',
    },
  ],
};
