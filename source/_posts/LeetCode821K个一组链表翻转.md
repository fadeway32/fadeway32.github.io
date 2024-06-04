---

layout: LeetCode779递归序列

title: LeetCode779递归序列

tags: Web

categories: Web

top: 29

path: /article/1784846531

abbrlink: 1784846531

date: 2024-02-27 21:02:00


---

# LeetCode K个一组链表翻转

~~~java
class ListNode{
    private int val;
    private ListNode next;
    
    public ListNode(){}
    
    public ListNode(int val){
        this.val = val;
    }
    
    public ListNode(int val,ListNode node){
        this.val=  val;
        this.next = node;
    }
    
    
    
}

class Solution{
    
    
    public ListNode getKreverseNode(ListNode  node,int k){
        
        ListNode dump  = new ListNode(0);
        dump.next = node;
        
        ListNode pre = dump;
       // ListNode start = dump;
        ListNode end  = dump;
        
        while(end.next != null){
            for(int i=0;i< k&& end != null;i++){
                end = end.next;
            }
            
            if(end == null){
                break;
            }
            ListNode start = pre.next;
            ListNode next = end.next;
            
            end.next = null;
            ListNode reverseNode  = reverse(start);
            pre.next= reverseNode;
            // end.next 接回去
            start.next= next;
            
           
            // 更新指针 //重置start的起始位置开始下一轮的转换
            pre = start;
            end = pre;
            
            
        }
        return dump.next;
        
        
        
    }
    
    // 链表反转
    public ListNode reverse(ListNode node){
        ListNode pre =null;
        ListNode cur =  node;
        while(cur != null){
            ListNode next = cur.next;
            cur.next= pre;
            pre = cur;
            cur = next;
        }
        return pre;
            
            
    }
    
    
}


~~~

